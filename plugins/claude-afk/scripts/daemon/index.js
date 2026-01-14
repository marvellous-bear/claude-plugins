#!/usr/bin/env node
// Claude AFK Daemon
// Singleton daemon that manages AFK sessions and Telegram notifications
//
// PRD Reference (lines 550-555):
// - Singleton management: Acquire file lock on startup, release on shutdown
// - Named pipe server: Listen for hook connections, handle requests
// - Session registry: Map session_id → short_token
// - Telegram poller: Call getUpdates every 2 seconds
// - State persistence: Store chat_id in ~/.claude/claude-afk/state.json

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const { acquireLock, getDefaultLockPath } = require('./singleton');
const { createIPCServer, getDefaultPipePath } = require('./ipc');
const { createSessionRegistry } = require('./sessions');
const { createTelegramClient, getBotToken } = require('./telegram');
const { getLastClaudeMessage, getLastUserMessage, getLastToolUse, formatToolInput, findToolResult, findUserMessage, getLineCount, findSubagentTranscripts, getFileMtime } = require('./transcript');
const { getClaudeAfkDir, getSessionsDir } = require('../session-lookup');

// Default configuration
const DEFAULT_CONFIG = {
  alwaysEnabled: false,
  retryInterval: 300,        // 5 minutes
  maxRetries: 3,
  permissionTimeout: 3600,   // 1 hour - match hook timeout
  stopFollowupTimeout: 3600, // 1 hour - match hook timeout
  staleUpdateThreshold: 300, // 5 minutes
  pollingInterval: 2,        // 2 seconds
  allowSinglePendingFallback: true,   // Route non-reply messages to single pending request
  idleShutdownTimeout: 300,  // 5 minutes
  maxLogSizeBytes: 10485760, // 10MB
  maxLogFiles: 5,
  bulkApprovalTools: ['Edit', 'Write'],  // Tools that support "all" approval
  transcriptPolling: {
    enabled: true,
    intervalMs: 3000,
    enableMtimeOptimization: true
  },
  hookTimeouts: {
    permissionRequest: 3600,  // 1 hour
    stop: 3600                // 1 hour
  }
};

/**
 * Deep merge two objects (for nested config support)
 * @param {Object} target - Base object
 * @param {Object} source - Object to merge in
 * @returns {Object} Merged result
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load configuration from file
 */
function loadConfig() {
  const configPath = path.join(getClaudeAfkDir(), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const userConfig = JSON.parse(content);
      return deepMerge(DEFAULT_CONFIG, userConfig);
    }
  } catch (e) {
    // Ignore errors, use defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Load state from file
 */
function loadState() {
  const statePath = path.join(getClaudeAfkDir(), 'state.json');
  try {
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (e) {
    // Ignore errors, use defaults
  }
  return { chatId: null, afkSessions: [], pendingRequests: {}, requestsBySession: {}, sessionWhitelists: {} };
}

/**
 * Save state to file
 */
function saveState(state) {
  const afkDir = getClaudeAfkDir();
  if (!fs.existsSync(afkDir)) {
    fs.mkdirSync(afkDir, { recursive: true });
  }
  const statePath = path.join(afkDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Escape Telegram Markdown special characters
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text safe for Markdown parse mode
 */
function escapeMarkdown(text) {
  if (!text) return text;
  // Telegram's original Markdown mode only needs: _ * ` [
  return text.replace(/([_*`\[])/g, '\\$1');
}

/**
 * Format a permission notification message
 * @param {string} token - Session token
 * @param {string} claudeContext - Context from Claude's transcript
 * @param {string} toolName - Name of the tool requesting permission
 * @param {string} message - The command/action being requested
 * @param {string} projectSlug - Project name
 * @param {boolean} allowBulkApproval - Whether "all" response is allowed for this tool
 */
function formatPermissionNotification(token, claudeContext, toolName, message, projectSlug, allowBulkApproval = false) {
  let notification = `[${escapeMarkdown(projectSlug)}] #${token}\n\n`;

  if (claudeContext) {
    notification += `${escapeMarkdown(claudeContext)}\n\n`;
  }

  notification += `*Permission:* ${escapeMarkdown(toolName)}\n`;
  notification += `${escapeMarkdown(message)}\n\n`;

  if (allowBulkApproval) {
    notification += `Reply: yes / no / all`;
  } else {
    notification += `Reply: yes / no`;
  }

  return notification;
}

/**
 * Format a stop notification message
 * Note: Returns plain text (no markdown) since claudeContext may contain arbitrary formatting
 */
function formatStopNotification(token, claudeContext, projectSlug) {
  let notification = `[${projectSlug}] #${token}\n\n`;

  if (claudeContext) {
    notification += `${claudeContext}\n\n`;
  }

  notification += `Task complete. Reply with follow-up instructions or ignore to stop.`;

  return notification;
}

/**
 * Parse user response for permission request
 * @param {string} text - User's response text
 * @param {boolean} allowBulkApproval - Whether "all" is a valid response
 * @returns {'approved'|'denied'|'approved_all'|null} - Decision or null if invalid
 */
function parsePermissionResponse(text, allowBulkApproval = false) {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y') {
    return 'approved';
  }
  if (normalized === 'no' || normalized === 'n') {
    return 'denied';
  }
  if (allowBulkApproval && (normalized === 'all' || normalized === 'yes all' || normalized === 'y all' || normalized === 'always')) {
    return 'approved_all';
  }
  return null; // Invalid response
}

/**
 * Find existing pending request by session, tool, and command
 * @param {Object} state - Daemon state
 * @param {string} sessionId - Session ID
 * @param {string} toolName - Tool name
 * @param {string} command - Command string
 * @returns {{request: Object, messageId: string}|null} Found request or null
 */
function findExistingPendingRequest(state, sessionId, toolName, command) {
  const sessionRequests = state.requestsBySession[sessionId] || [];
  for (const msgId of sessionRequests) {
    const req = state.pendingRequests[msgId];
    if (req && req.tool === toolName && req.command === command) {
      return { request: req, messageId: msgId };
    }
  }
  return null;
}

/**
 * Remove request from dual-index structure
 * @param {Object} state - Daemon state
 * @param {string} messageId - Message ID (must be string)
 * @param {string} sessionId - Session ID
 */
function removeFromDualIndex(state, messageId, sessionId) {
  const msgIdStr = String(messageId);

  // Remove from pendingRequests
  delete state.pendingRequests[msgIdStr];

  // Remove from requestsBySession
  const sessionRequests = state.requestsBySession[sessionId];
  if (sessionRequests) {
    const idx = sessionRequests.indexOf(msgIdStr);
    if (idx > -1) {
      sessionRequests.splice(idx, 1);
    }
    // Clean up empty session array
    if (sessionRequests.length === 0) {
      delete state.requestsBySession[sessionId];
    }
  }
}

/**
 * Check if max retries exceeded
 * @param {number} retryCount - Current retry count
 * @param {number} maxRetries - Maximum allowed retries
 * @returns {boolean} True if exceeded
 */
function isMaxRetriesExceeded(retryCount, maxRetries) {
  return retryCount >= maxRetries;
}

/**
 * Check if request still exists (race condition check)
 * @param {Object} state - Daemon state
 * @param {string|number} messageId - Message ID
 * @returns {{exists: boolean, pending: Object|null}} Check result
 */
function checkRequestExists(state, messageId) {
  const msgIdStr = String(messageId);
  const pending = state.pendingRequests[msgIdStr];
  return {
    exists: !!pending,
    pending: pending || null
  };
}

/**
 * Create the daemon
 */
async function createDaemon() {
  const config = loadConfig();
  let state = loadState();

  const registry = createSessionRegistry();
  const telegram = createTelegramClient(getBotToken(), {
    staleThreshold: config.staleUpdateThreshold
  });

  const ipcServer = createIPCServer(getDefaultPipePath());

  let lockRelease = null;
  let pollingInterval = null;
  let transcriptPollingInterval = null;
  let telegramOffset = 0;
  let lastActivity = Date.now();
  let running = false;
  let consecutiveConflictErrors = 0;
  let isPolling = false; // Guard against overlapping getUpdates calls
  let isPollingTranscripts = false; // Guard against concurrent transcript poll cycles

  // Track connected sockets waiting for responses
  const waitingSockets = new Map(); // messageId -> { socket, requestId, sessionId, type, respond }
  const socketToMessageIds = new Map(); // socket -> Set of messageIds (for cleanup on disconnect)

  /**
   * Clean up pending requests when a socket disconnects
   * This happens when user responds in Claude Code UI directly
   */
  function handleSocketDisconnect(socket) {
    const messageIds = socketToMessageIds.get(socket);
    if (!messageIds || messageIds.size === 0) return;

    for (const messageId of messageIds) {
      const waiting = waitingSockets.get(messageId);
      if (waiting) {
        // Clear any pending timeouts
        if (waiting.timeout) {
          clearTimeout(waiting.timeout);
        }

        // Remove from registry
        registry.removePendingByMessageId(messageId);

        // Remove from waiting sockets
        waitingSockets.delete(messageId);

        // Delete the stale notification from Telegram (cleaner than follow-up message)
        if (state.chatId) {
          telegram.deleteMessage(state.chatId, messageId).catch(() => {});
        }
      }
    }

    socketToMessageIds.delete(socket);

    // Persist state
    state.pendingRequests = registry.exportState().pendingRequests;
    saveState(state);
  }

  /**
   * Track a socket waiting for a message response
   */
  function trackWaitingSocket(messageId, socket, waitingData) {
    waitingSockets.set(messageId, { ...waitingData, socket });

    if (!socketToMessageIds.has(socket)) {
      socketToMessageIds.set(socket, new Set());
    }
    socketToMessageIds.get(socket).add(messageId);
  }

  /**
   * Handle incoming IPC requests
   */
  function handleRequest(msg, respond, socket) {
    lastActivity = Date.now();

    switch (msg.type) {
      case 'permission_request':
        handlePermissionRequest(msg, respond, socket);
        break;

      case 'stop_request':
        handleStopRequest(msg, respond, socket);
        break;

      case 'enable_afk':
        handleEnableAfk(msg, respond);
        break;

      case 'disable_afk':
        handleDisableAfk(msg, respond);
        break;

      case 'status':
        handleStatus(msg, respond);
        break;

      default:
        respond({
          type: 'response',
          request_id: msg.request_id,
          status: 'error',
          message: `Unknown request type: ${msg.type}`
        });
    }
  }

  /**
   * Check if a tool is whitelisted for bulk approval in a session
   */
  function isToolWhitelisted(sessionId, toolName) {
    const whitelist = state.sessionWhitelists?.[sessionId];
    return whitelist && whitelist.includes(toolName);
  }

  /**
   * Add a tool to the session whitelist
   */
  function addToWhitelist(sessionId, toolName) {
    if (!state.sessionWhitelists) {
      state.sessionWhitelists = {};
    }
    if (!state.sessionWhitelists[sessionId]) {
      state.sessionWhitelists[sessionId] = [];
    }
    if (!state.sessionWhitelists[sessionId].includes(toolName)) {
      state.sessionWhitelists[sessionId].push(toolName);
      saveState(state);
    }
  }

  /**
   * Clear whitelist for a session
   */
  function clearWhitelist(sessionId) {
    if (state.sessionWhitelists && state.sessionWhitelists[sessionId]) {
      delete state.sessionWhitelists[sessionId];
      saveState(state);
    }
  }

  /**
   * Check if bulk approval is allowed for a tool
   */
  function isBulkApprovalAllowed(toolName) {
    return config.bulkApprovalTools && config.bulkApprovalTools.includes(toolName);
  }

  /**
   * Handle permission request
   */
  async function handlePermissionRequest(msg, respond, socket) {
    const { session_id, terminal_id, tool_name, message, transcript_path, cwd, request_id } = msg;

    // Check if AFK is enabled for this session
    if (!config.alwaysEnabled && !registry.isAfkEnabled(session_id)) {
      respond({
        type: 'response',
        request_id,
        status: 'not_enabled'
      });
      return;
    }

    // Check if Telegram is configured
    if (!telegram.isConfigured()) {
      respond({
        type: 'response',
        request_id,
        status: 'not_configured',
        message: 'Telegram bot not configured. Run /claude-afk:setup'
      });
      return;
    }

    // Check if we have a chat ID
    if (!state.chatId) {
      respond({
        type: 'response',
        request_id,
        status: 'not_configured',
        message: 'No chat ID configured. Send /start to your Telegram bot'
      });
      return;
    }

    // Check if tool is whitelisted for this session (bulk approval)
    if (isToolWhitelisted(session_id, tool_name)) {
      respond({
        type: 'response',
        request_id,
        status: 'approved',
        bulk_approved: true
      });
      return;
    }

    // Check for existing pending request (retry scenario)
    // Search requestsBySession for matching request (Dry Run Resolution #8)
    const existing = findExistingPendingRequest(state, session_id, tool_name, message);

    if (existing) {
      // Increment retry count
      existing.request.retryCount = (existing.request.retryCount || 0) + 1;

      if (isMaxRetriesExceeded(existing.request.retryCount, config.maxRetries)) {
        // Max retries exceeded - clean up and delete Telegram message
        removeFromDualIndex(state, existing.messageId, session_id);

        // Delete the stale permission notification from Telegram
        if (state.chatId && existing.messageId) {
          telegram.deleteMessage(state.chatId, existing.messageId).catch(() => {});
        }

        saveState(state);

        respond({
          type: 'response',
          request_id,
          status: 'timeout_final',
          message: 'User unavailable after multiple retries.'
        });
        return;
      }
    }

    // Get Claude context from transcript - try assistant message first, fall back to user message
    let claudeContext = await getLastClaudeMessage(transcript_path, { maxLength: 500 });
    if (!claudeContext) {
      // If no assistant text, show what the user asked for as context
      const userMessage = await getLastUserMessage(transcript_path, { maxLength: 300 });
      if (userMessage) {
        claudeContext = `User: ${userMessage}`;
      }
    }

    // Get the actual tool input from transcript (since PermissionRequest doesn't include it)
    const toolUse = await getLastToolUse(transcript_path);
    const actualCommand = toolUse
      ? formatToolInput(toolUse.tool, toolUse.input)
      : message || '(unknown)';

    // Register session if not already registered
    const projectSlug = path.basename(cwd || '.') || 'project';
    const token = registry.register(session_id, projectSlug);

    // Check if bulk approval is allowed for this tool type
    const allowBulkApproval = isBulkApprovalAllowed(tool_name);

    // Send Telegram notification
    try {
      const notificationText = formatPermissionNotification(
        token, claudeContext, tool_name, actualCommand, projectSlug, allowBulkApproval
      );

      const result = await telegram.sendMessage(state.chatId, notificationText);

      // Store with dual-index structure (PRD lines 804-822)
      const msgIdStr = String(result.message_id); // String normalization
      state.pendingRequests[msgIdStr] = {
        sessionId: session_id,
        tool: tool_name,
        command: message,
        tool_use_id: toolUse?.id,
        requestType: 'permission',
        transcriptPath: transcript_path,
        projectDir: cwd,
        terminalId: terminal_id,
        lastCheckedOffset: 0,
        firstRequestAt: new Date().toISOString(),
        requestId: request_id,
        retryCount: existing?.request.retryCount || 0,
        socketAlive: true
      };

      // Add to requestsBySession index
      if (!state.requestsBySession[session_id]) {
        state.requestsBySession[session_id] = [];
      }
      state.requestsBySession[session_id].push(msgIdStr);

      // Set up permission timeout - cleanup if no response within timeout
      const permissionTimeout = setTimeout(() => {
        const waiting = waitingSockets.get(result.message_id);
        if (waiting) {
          waitingSockets.delete(result.message_id);
          // Clean up socket tracking
          const msgIds = socketToMessageIds.get(socket);
          if (msgIds) msgIds.delete(result.message_id);

          // Remove from dual-index
          removeFromDualIndex(state, result.message_id, session_id);

          // Delete the stale permission notification from Telegram
          if (state.chatId) {
            telegram.deleteMessage(state.chatId, result.message_id).catch(() => {});
          }

          // Persist state
          saveState(state);

          // Tell hook to passthrough if socket is still alive
          if (waiting.socket && !waiting.socket.destroyed) {
            try {
              waiting.respond({
                type: 'response',
                request_id: request_id,
                status: 'timeout_retry',
                message: 'No response within timeout'
              });
            } catch (e) {
              // Socket dead, ignore
            }
          }
        }
      }, config.permissionTimeout * 1000);

      // Track socket waiting for response (enables cleanup on disconnect)
      trackWaitingSocket(result.message_id, socket, {
        respond,
        requestId: request_id,
        sessionId: session_id,
        type: 'permission',
        toolName: tool_name,
        allowBulkApproval,
        timeout: permissionTimeout
      });

      // Persist state
      saveState(state);

      // Don't respond yet - wait for Telegram reply

    } catch (err) {
      respond({
        type: 'response',
        request_id,
        status: 'error',
        message: `Failed to send notification: ${err.message}`
      });
    }
  }

  /**
   * Handle stop request
   */
  async function handleStopRequest(msg, respond, socket) {
    const { session_id, terminal_id, transcript_path, cwd, request_id } = msg;

    // Check if AFK is enabled for this session
    if (!config.alwaysEnabled && !registry.isAfkEnabled(session_id)) {
      respond({
        type: 'response',
        request_id,
        status: 'not_enabled'
      });
      return;
    }

    // Check if Telegram is configured
    if (!telegram.isConfigured() || !state.chatId) {
      respond({
        type: 'response',
        request_id,
        status: 'not_configured'
      });
      return;
    }

    // Get Claude context
    const claudeContext = await getLastClaudeMessage(transcript_path, { maxLength: 500 });

    // Get or create token
    const projectSlug = path.basename(cwd || '.') || 'project';
    const token = registry.register(session_id, projectSlug);

    try {
      const notificationText = formatStopNotification(token, claudeContext, projectSlug);
      // Use default Markdown parsing - claudeContext is not escaped so markdown renders
      const result = await telegram.sendMessage(state.chatId, notificationText);

      // Get current line count for initial offset (Dry Run Resolution #5)
      const currentOffset = await getLineCount(transcript_path);

      // Store with dual-index structure (PRD lines 827-843)
      const msgIdStr = String(result.message_id); // String normalization
      state.pendingRequests[msgIdStr] = {
        sessionId: session_id,
        requestType: 'stop',
        transcriptPath: transcript_path,
        projectDir: cwd,
        terminalId: terminal_id,
        lastCheckedOffset: currentOffset,
        firstRequestAt: new Date().toISOString(),
        requestId: request_id,
        socketAlive: true
      };

      // Add to requestsBySession index
      if (!state.requestsBySession[session_id]) {
        state.requestsBySession[session_id] = [];
      }
      state.requestsBySession[session_id].push(msgIdStr);

      saveState(state);

      // Track socket waiting for response (enables cleanup on disconnect)
      const stopTimeout = setTimeout(() => {
        // No response within timeout - stop
        const waiting = waitingSockets.get(result.message_id);
        if (waiting) {
          waitingSockets.delete(result.message_id);
          // Clean up socket tracking
          const msgIds = socketToMessageIds.get(socket);
          if (msgIds) msgIds.delete(result.message_id);

          // Delete the stale stop notification from Telegram
          if (state.chatId) {
            telegram.deleteMessage(state.chatId, result.message_id).catch(() => {});
          }

          respond({
            type: 'response',
            request_id,
            status: 'stop'
          });
        }
      }, config.stopFollowupTimeout * 1000);

      trackWaitingSocket(result.message_id, socket, {
        respond,
        requestId: request_id,
        sessionId: session_id,
        type: 'stop',
        timeout: stopTimeout
      });

    } catch (err) {
      respond({
        type: 'response',
        request_id,
        status: 'error',
        message: `Failed to send notification: ${err.message}`
      });
    }
  }

  /**
   * Handle enable AFK request
   */
  function handleEnableAfk(msg, respond) {
    const { session_id, request_id } = msg;

    registry.enableAfk(session_id);

    // Persist
    state.afkSessions = registry.getAfkEnabledSessions();
    saveState(state);

    respond({
      type: 'response',
      request_id,
      status: 'enabled'
    });
  }

  /**
   * Handle disable AFK request
   */
  function handleDisableAfk(msg, respond) {
    const { session_id, request_id } = msg;

    registry.disableAfk(session_id);

    // Clear any bulk approval whitelist for this session
    clearWhitelist(session_id);

    // Persist
    state.afkSessions = registry.getAfkEnabledSessions();
    saveState(state);

    respond({
      type: 'response',
      request_id,
      status: 'disabled'
    });
  }

  /**
   * Handle status request
   */
  function handleStatus(msg, respond) {
    respond({
      type: 'response',
      request_id: msg.request_id,
      status: 'status_response',
      daemon_running: true,
      telegram_configured: telegram.isConfigured(),
      chat_id_configured: !!state.chatId,
      afk_sessions: registry.getAfkEnabledSessions(),
      pending_requests: registry.getPendingCount(),
      always_enabled: config.alwaysEnabled,
      bulk_approval_tools: config.bulkApprovalTools,
      session_whitelists: state.sessionWhitelists || {}
    });
  }

  /**
   * Process Telegram updates
   */
  async function processTelegramUpdates() {
    if (!telegram.isConfigured()) return;
    if (isPolling) return; // Skip if previous poll still in progress

    isPolling = true;

    try {
      const updates = await telegram.getUpdates(telegramOffset);
      consecutiveConflictErrors = 0; // Reset on success

      for (const update of updates) {
        telegramOffset = update.update_id + 1;
        await processUpdate(update);
      }

    } catch (err) {
      // Check for Telegram conflict error (another bot instance polling)
      if (err.message && err.message.includes('Conflict')) {
        consecutiveConflictErrors++;

        if (consecutiveConflictErrors >= 3) {
          console.error('Telegram conflict: Another bot instance is polling. Shutting down this daemon.');

          // Notify user once if we have a chat ID
          if (state.chatId) {
            await telegram.sendMessage(state.chatId,
              '⚠️ Claude AFK detected another bot instance polling.\n\n' +
              'This daemon is shutting down. The other instance will handle notifications.\n\n' +
              'If this was unexpected, check for daemons running on other machines.'
            ).catch(() => {}); // Ignore notification failures
          }

          // Graceful shutdown - let the other instance take over
          console.log('Exiting to avoid conflict with other daemon instance.');
          await shutdown();
          process.exit(0);
        }
      } else {
        // Log other errors but don't crash
        console.error('Telegram polling error:', err.message);
      }
    } finally {
      isPolling = false;
    }
  }

  /**
   * Process a single Telegram update
   */
  async function processUpdate(update) {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat?.id;
    const text = msg.text?.trim();

    // Handle /start command for pairing
    if (text === '/start' && chatId) {
      state.chatId = chatId;
      saveState(state);

      await telegram.sendMessage(chatId,
        '✅ Claude AFK is now paired with this chat!\n\n' +
        'You\'ll receive permission requests here when AFK mode is enabled.'
      );
      return;
    }

    // Only process messages from paired chat
    if (chatId !== state.chatId) return;

    // Check if this is a reply to a pending message
    const replyToMessageId = msg.reply_to_message?.message_id;

    if (!replyToMessageId) {
      // Not a reply - check single pending fallback
      const pendingRequestCount = Object.keys(state.pendingRequests).length;
      if (config.allowSinglePendingFallback && pendingRequestCount === 1) {
        // Route to the only pending request
        const messageId = Object.keys(state.pendingRequests)[0];
        const waiting = waitingSockets.get(Number(messageId));
        const pending = state.pendingRequests[messageId];
        
        if (waiting) {
          // Normal case: socket is alive, handle response
          handleResponse(Number(messageId), waiting, text);
        } else if (pending) {
          // Socket is dead but request still exists (resumed session scenario)
          // Clean up the pending request and acknowledge the response
          const decision = parsePermissionResponse(text, isBulkApprovalAllowed(pending.tool));
          
          if (decision) {
            // Valid response - clean up and acknowledge
            removeFromDualIndex(state, messageId, pending.sessionId);
            saveState(state);
            
            // Delete the notification message
            await telegram.deleteMessage(chatId, messageId).catch(() => {});
            
            // Inform user that the session is no longer active
            await telegram.sendMessage(chatId,
              '✅ Response recorded, but the session is no longer active. ' +
              'If you resumed the session, you may need to re-run the command.'
            );
          } else {
            // Invalid response
            await telegram.sendMessage(chatId,
              "Reply 'yes' or 'no'"
            );
          }
        }
      } else if (pendingRequestCount > 0) {
        await telegram.sendMessage(chatId,
          'Please reply directly to a notification message.'
        );
      }
      return;
    }

    // Find waiting socket for this message
    const waiting = waitingSockets.get(replyToMessageId);

    if (!waiting) {
      await telegram.sendMessage(chatId,
        'This request has expired or already been handled.'
      );
      return;
    }

    handleResponse(replyToMessageId, waiting, text);
  }

  /**
   * Handle response to a pending request (PRD lines 869-903)
   */
  async function handleResponse(messageId, waiting, text) {
    // Race condition check: verify request still exists
    const check = checkRequestExists(state, messageId);

    // Check if transcript polling already detected resolution
    if (!check.exists) {
      await telegram.sendMessage(state.chatId, '✅ Already handled locally').catch(() => {});
      await telegram.deleteMessage(state.chatId, messageId).catch(() => {});
      return;
    }

    const pending = check.pending;

    // Clear stop timeout if present
    if (waiting.timeout) {
      clearTimeout(waiting.timeout);
    }

    waitingSockets.delete(messageId);

    // Clean up socket tracking
    if (waiting.socket) {
      const msgIds = socketToMessageIds.get(waiting.socket);
      if (msgIds) msgIds.delete(messageId);
    }

    if (waiting.type === 'permission') {
      const decision = parsePermissionResponse(text, waiting.allowBulkApproval);

      if (!decision) {
        // Invalid response - ask again with appropriate options
        const validResponses = waiting.allowBulkApproval
          ? "Reply 'yes', 'no', or 'all'"
          : "Reply 'yes' or 'no'";
        telegram.sendMessage(state.chatId, validResponses);
        waitingSockets.set(messageId, waiting);
        return;
      }

      // Handle bulk approval - add to whitelist
      if (decision === 'approved_all' && waiting.toolName && waiting.sessionId) {
        addToWhitelist(waiting.sessionId, waiting.toolName);
        // Send confirmation
        telegram.sendMessage(state.chatId,
          `✓ All ${waiting.toolName} requests will be auto-approved for this session.`
        ).catch(() => {});
      }

      // Remove from dual-index
      removeFromDualIndex(state, messageId, waiting.sessionId);

      saveState(state);

      // For approved_all, respond with 'approved' status
      const responseStatus = decision === 'approved_all' ? 'approved' : decision;

      // Try to send to hook (may fail if socket dead)
      try {
        if (!waiting.socket || waiting.socket.destroyed) {
          throw new Error('Socket dead');
        }
        waiting.respond({
          type: 'response',
          request_id: waiting.requestId,
          status: responseStatus,
          message: decision === 'denied' ? 'User denied' : undefined,
          bulk_approved: decision === 'approved_all'
        });
      } catch (err) {
        // Socket send failed - check if resolved locally
        const resolved = await checkTranscriptForResolution(pending);

        if (resolved) {
          await telegram.sendMessage(state.chatId, '✅ Already handled locally').catch(() => {});
        } else {
          // Can't deliver, session may be dead
          await telegram.sendMessage(state.chatId,
            '⚠️ Unable to deliver response - session may have ended. Please respond in Claude Code if still needed.'
          ).catch(() => {});
        }
      }

    } else if (waiting.type === 'stop') {
      // Remove from dual-index
      removeFromDualIndex(state, messageId, waiting.sessionId);

      saveState(state);

      // Truncate long responses
      let instructions = text;
      if (instructions.length > 2000) {
        instructions = instructions.substring(0, 1997) + `... (truncated, original was ${text.length} chars)`;
      }

      // Try to send to hook (may fail if socket dead)
      try {
        if (!waiting.socket || waiting.socket.destroyed) {
          throw new Error('Socket dead');
        }
        waiting.respond({
          type: 'response',
          request_id: waiting.requestId,
          status: 'continue',
          instructions
        });
      } catch (err) {
        // Socket send failed - check if resolved locally
        const resolved = await checkTranscriptForResolution(pending);

        if (resolved) {
          await telegram.sendMessage(state.chatId, '✅ Already handled locally').catch(() => {});
        } else {
          // Can't deliver, session may be dead
          await telegram.sendMessage(state.chatId,
            '⚠️ Unable to deliver response - session may have ended. Please respond in Claude Code if still needed.'
          ).catch(() => {});
        }
      }
    }
  }

  /**
   * Poll transcripts for local resolution detection (PRD lines 652-683)
   */
  async function pollTranscripts() {
    if (isPollingTranscripts) return; // Skip if previous cycle still running
    isPollingTranscripts = true;

    try {
      // Group requests by session for efficient polling
      for (const [sessionId, messageIds] of Object.entries(state.requestsBySession)) {
        for (const messageId of messageIds) {
          const request = state.pendingRequests[messageId];
          if (!request) continue;

          // Check if socket is dead (Windows doesn't fire close events reliably)
          const waiting = waitingSockets.get(messageId);
          if (waiting?.socket?.destroyed) {
            console.log(`Socket dead for message ${messageId}, cleaning up`);
            await handleLocalResolution(messageId, request, 'socket_closed');
            continue;
          }

          if (request.requestType === 'permission') {
            await checkPermissionResolution(messageId, request);
          } else if (request.requestType === 'stop') {
            await checkStopResolution(messageId, request);
          }
        }

        // Check session validity once per session (not per request)
        const firstRequest = state.pendingRequests[messageIds[0]];
        if (firstRequest) {
          await checkSessionValidity(sessionId, messageIds);
        }
      }
    } catch (err) {
      // Safe Mode - don't crash daemon on transcript polling errors
      console.error('Transcript polling error:', err.message);
    } finally {
      isPollingTranscripts = false;
    }
  }

  /**
   * Check permission resolution in transcript (PRD lines 685-716)
   */
  async function checkPermissionResolution(messageId, request) {
    try {
      // 1. Check main transcript for tool_result
      const result = await findToolResult(
        request.transcriptPath,
        request.tool_use_id,
        request.lastCheckedOffset
      );

      if (result?.found) {
        await handleLocalResolution(messageId, request, result.isError ? 'denied' : 'approved');
        return;
      }

      // 2. Check subagent transcripts if no match
      if (request.projectDir) {
        const subagentFiles = await findSubagentTranscripts(request.transcriptPath);
        for (const file of subagentFiles) {
          const mtime = await getFileMtime(file);
          // Only check recently modified files (within 10 seconds)
          if (mtime && mtime > Date.now() - 10000) {
            const subResult = await findToolResult(file, request.tool_use_id, 0);
            if (subResult?.found) {
              await handleLocalResolution(messageId, request, subResult.isError ? 'denied' : 'approved');
              return;
            }
          }
        }
      }

      // Update offset for next poll
      if (result) {
        request.lastCheckedOffset = result.offset;
      }
    } catch (err) {
      // Safe Mode - log but don't throw
      console.error(`Error checking permission resolution for ${messageId}:`, err.message);
    }
  }

  /**
   * Check stop resolution in transcript (PRD lines 718-729)
   */
  async function checkStopResolution(messageId, request) {
    try {
      const result = await findUserMessage(
        request.transcriptPath,
        request.lastCheckedOffset
      );

      if (result?.found) {
        await handleLocalResolution(messageId, request, 'local_followup');
      }

      // Update offset for next poll
      if (result) {
        request.lastCheckedOffset = result.offset;
      }
    } catch (err) {
      // Safe Mode - log but don't throw
      console.error(`Error checking stop resolution for ${messageId}:`, err.message);
    }
  }

  /**
   * Check session validity (PRD lines 731-749)
   */
  async function checkSessionValidity(sessionId, messageIds) {
    try {
      // Get terminalId from first request
      const firstRequest = state.pendingRequests[messageIds[0]];
      if (!firstRequest?.terminalId) return;

      const sessionFile = path.join(getSessionsDir(), `${firstRequest.terminalId}.json`);
      try {
        const content = await fsPromises.readFile(sessionFile, 'utf8');
        const session = JSON.parse(content);

        if (session.sessionId !== sessionId) {
          // Session restarted - clean up ALL requests for this session
          await handleSessionExpired(sessionId, messageIds);
        }
      } catch (err) {
        // File gone or unreadable - session likely ended
        await handleSessionExpired(sessionId, messageIds);
      }
    } catch (err) {
      // Safe Mode - log but don't throw
      console.error(`Error checking session validity for ${sessionId}:`, err.message);
    }
  }

  /**
   * Handle local resolution detection (PRD lines 751-781)
   */
  async function handleLocalResolution(messageId, request, resolution) {
    try {
      // 1. Try to notify hook if socket still alive
      const waiting = waitingSockets.get(messageId);
      if (waiting?.socket && !waiting.socket.destroyed) {
        waiting.respond({
          type: 'response',
          request_id: waiting.requestId,
          status: 'resolved_locally',
          resolution
        });
      }

      // 2. Delete Telegram message (silently)
      await telegram.deleteMessage(state.chatId, messageId).catch(() => {});

      // 3. Clean up state (dual-index)
      removeFromDualIndex(state, messageId, request.sessionId);

      waitingSockets.delete(messageId);
      saveState(state);
    } catch (err) {
      // Safe Mode - log but don't throw
      console.error(`Error handling local resolution for ${messageId}:`, err.message);
    }
  }

  /**
   * Handle session expired (PRD lines 783-797)
   */
  async function handleSessionExpired(sessionId, messageIds) {
    try {
      // 1. Notify user via Telegram (once per session, not per request)
      await telegram.sendMessage(state.chatId, '⚠️ Session ended - pending requests expired').catch(() => {});

      // 2. Delete ALL notifications for this session
      for (const messageId of messageIds) {
        await telegram.deleteMessage(state.chatId, messageId).catch(() => {});
        delete state.pendingRequests[String(messageId)];
        waitingSockets.delete(messageId);
      }

      // 3. Clean up session index
      delete state.requestsBySession[sessionId];
      saveState(state);
    } catch (err) {
      // Safe Mode - log but don't throw
      console.error(`Error handling session expired for ${sessionId}:`, err.message);
    }
  }

  /**
   * Check transcript for resolution (helper for race condition handling) (PRD lines 905-914)
   */
  async function checkTranscriptForResolution(request) {
    try {
      if (request.requestType === 'permission') {
        const result = await findToolResult(request.transcriptPath, request.tool_use_id, 0);
        return result?.found || false;
      } else if (request.requestType === 'stop') {
        const result = await findUserMessage(request.transcriptPath, request.lastCheckedOffset);
        return result?.found || false;
      }
      return false;
    } catch (err) {
      // Safe Mode - return false on error
      return false;
    }
  }

  /**
   * Start the daemon
   */
  async function start() {
    // Try to acquire lock
    const lock = await acquireLock(getDefaultLockPath());

    if (!lock.acquired) {
      console.error('Another daemon instance is already running');
      process.exit(1);
    }

    lockRelease = lock.release;

    // Import persisted state
    registry.importState(state);

    // Clean up orphaned pending requests on startup
    const hasPendingRequests = state.pendingRequests && Object.keys(state.pendingRequests).length > 0;
    const hasStaleSessionIndex = state.requestsBySession && Object.keys(state.requestsBySession).length > 0;

    if (hasPendingRequests || hasStaleSessionIndex) {
      if (hasPendingRequests && telegram.isConfigured() && state.chatId) {
        for (const [messageId, request] of Object.entries(state.pendingRequests)) {
          await telegram.sendMessage(state.chatId,
            `⚠️ Daemon restarted. Previous request expired:\n` +
            `${request.tool}: ${request.command || '(no command)'}\n` +
            `Please re-run the command if still needed.`
          );
        }
      }
      // Clear both indices to avoid stale data
      state.pendingRequests = {};
      state.requestsBySession = {};
      saveState(state);
    }

    // Set up IPC message handler
    ipcServer.onMessage((msg, respond, socket) => {
      handleRequest(msg, respond, socket);
    });

    // Set up disconnect handler to clean up when clients disconnect
    // This handles the case where user responds in Claude Code UI directly
    ipcServer.onDisconnect((socket) => {
      handleSocketDisconnect(socket);
    });

    // Start IPC server
    await ipcServer.start();

    // Start Telegram polling
    pollingInterval = setInterval(
      processTelegramUpdates,
      config.pollingInterval * 1000
    );

    // Start transcript polling (PRD lines 850-853)
    if (config.transcriptPolling?.enabled !== false) {
      transcriptPollingInterval = setInterval(
        pollTranscripts,
        config.transcriptPolling?.intervalMs || 3000
      );
    }

    running = true;
    console.log('Claude AFK daemon started');

    // Set up signal handlers
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }

  /**
   * Stop the daemon
   */
  async function stop() {
    if (!running) return;
    running = false;

    console.log('Stopping daemon...');

    // Stop polling
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // Stop transcript polling (PRD lines 858-862)
    if (transcriptPollingInterval) {
      clearInterval(transcriptPollingInterval);
      transcriptPollingInterval = null;
    }

    // Stop IPC server
    await ipcServer.stop();

    // Release lock
    if (lockRelease) {
      await lockRelease();
      lockRelease = null;
    }

    console.log('Daemon stopped');
    process.exit(0);
  }

  return { start, stop };
}

// Run if executed directly
if (require.main === module) {
  createDaemon()
    .then(daemon => daemon.start())
    .catch(err => {
      console.error('Failed to start daemon:', err.message);
      process.exit(1);
    });
}

module.exports = {
  createDaemon,
  loadConfig,
  loadState,
  saveState,
  // Exported for testing
  findExistingPendingRequest,
  removeFromDualIndex,
  isMaxRetriesExceeded,
  checkRequestExists,
  formatPermissionNotification,
  formatStopNotification,
  parsePermissionResponse,
  DEFAULT_CONFIG
};
