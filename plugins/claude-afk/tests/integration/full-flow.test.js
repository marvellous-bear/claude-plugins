// Integration test: Full permission flow
// Tests the complete flow from hook → daemon → Telegram → response
//
// PRD Reference (lines 1497-1531):
// - Start daemon with mocked Telegram
// - Simulate hook firing
// - Simulate user reply
// - Verify output

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createIPCServer, createIPCClient } = require('../../scripts/daemon/ipc');
const { createSessionRegistry } = require('../../scripts/daemon/sessions');
const { createTelegramClient } = require('../../scripts/daemon/telegram');
const { getLastClaudeMessage } = require('../../scripts/daemon/transcript');

// Test fixture path
const FIXTURE_TRANSCRIPT = path.join(__dirname, '..', 'fixtures', 'sample-transcript.jsonl');

/**
 * Create a mock Telegram client that captures calls and allows simulating replies
 */
function createTelegramMock() {
  const sentMessages = [];
  const replies = [];
  let messageIdCounter = 1000;
  let updateIdCounter = 1;

  return {
    isConfigured: () => true,

    async sendMessage(chatId, text) {
      const message = {
        message_id: messageIdCounter++,
        chat: { id: chatId },
        text,
        date: Math.floor(Date.now() / 1000)
      };
      sentMessages.push(message);
      return message;
    },

    async getUpdates(offset) {
      // Return any pending simulated replies
      const updates = replies.splice(0, replies.length).map(reply => ({
        update_id: updateIdCounter++,
        message: {
          message_id: messageIdCounter++,
          chat: { id: reply.chatId },
          text: reply.text,
          date: Math.floor(Date.now() / 1000),
          reply_to_message: reply.replyTo ? { message_id: reply.replyTo } : undefined
        }
      }));
      return updates;
    },

    // Test helpers
    getSentMessages: () => [...sentMessages],
    getLastSentMessage: () => sentMessages[sentMessages.length - 1],

    simulateReply(text, replyToMessageId, chatId = 12345) {
      replies.push({
        text,
        replyTo: replyToMessageId,
        chatId
      });
    },

    simulateStart(chatId = 12345) {
      replies.push({
        text: '/start',
        replyTo: null,
        chatId
      });
    }
  };
}

/**
 * Create a test daemon harness
 * This wires up the components for testing without starting the full daemon
 */
function createTestDaemon(options = {}) {
  const pipePath = options.pipePath || path.join(os.tmpdir(), `claude-afk-test-${Date.now()}.sock`);
  const telegram = options.telegram || createTelegramMock();
  const registry = createSessionRegistry();
  const config = {
    alwaysEnabled: options.alwaysEnabled || false,
    maxRetries: options.maxRetries || 3,
    stopFollowupTimeout: options.stopFollowupTimeout || 2, // Short for testing
    ...options.config
  };

  let state = {
    chatId: options.chatId || null,
    afkSessions: [],
    pendingRequests: {}
  };

  const server = createIPCServer(pipePath);
  const waitingSockets = new Map();
  let running = false;

  /**
   * Handle incoming IPC requests
   */
  function handleRequest(msg, respond, socket) {
    switch (msg.type) {
      case 'permission_request':
        handlePermissionRequest(msg, respond, socket);
        break;

      case 'stop_request':
        handleStopRequest(msg, respond, socket);
        break;

      case 'enable_afk':
        registry.enableAfk(msg.session_id);
        state.afkSessions = registry.getAfkEnabledSessions();
        respond({
          type: 'response',
          request_id: msg.request_id,
          status: 'enabled'
        });
        break;

      case 'disable_afk':
        registry.disableAfk(msg.session_id);
        state.afkSessions = registry.getAfkEnabledSessions();
        respond({
          type: 'response',
          request_id: msg.request_id,
          status: 'disabled'
        });
        break;

      case 'status':
        respond({
          type: 'response',
          request_id: msg.request_id,
          status: 'status_response',
          daemon_running: true,
          telegram_configured: telegram.isConfigured(),
          chat_id_configured: !!state.chatId,
          afk_sessions: registry.getAfkEnabledSessions(),
          pending_requests: registry.getPendingCount(),
          always_enabled: config.alwaysEnabled
        });
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

  async function handlePermissionRequest(msg, respond, socket) {
    const { session_id, tool_name, message, transcript_path, cwd, request_id } = msg;

    // Check if AFK is enabled
    if (!config.alwaysEnabled && !registry.isAfkEnabled(session_id)) {
      respond({ type: 'response', request_id, status: 'not_enabled' });
      return;
    }

    // Check Telegram config
    if (!telegram.isConfigured()) {
      respond({ type: 'response', request_id, status: 'not_configured', message: 'No bot token' });
      return;
    }

    if (!state.chatId) {
      respond({ type: 'response', request_id, status: 'not_configured', message: 'No chat ID' });
      return;
    }

    // Get Claude context
    const claudeContext = await getLastClaudeMessage(transcript_path, { maxLength: 500 });

    // Register session
    const projectSlug = path.basename(cwd || '.') || 'project';
    const token = registry.register(session_id, projectSlug);

    // Send notification
    let notificationText = `[${projectSlug}] #${token}\n\n`;
    if (claudeContext) {
      notificationText += `${claudeContext}\n\n`;
    }
    notificationText += `Permission: ${tool_name}\n> ${message}\n\nReply to this message: yes / no`;

    try {
      const result = await telegram.sendMessage(state.chatId, notificationText);

      // Track pending request
      registry.addPendingRequest(session_id, {
        messageId: result.message_id,
        tool: tool_name,
        command: message,
        requestId: request_id
      });

      // Track socket waiting for response
      waitingSockets.set(result.message_id, {
        respond,
        requestId: request_id,
        sessionId: session_id,
        type: 'permission'
      });

    } catch (err) {
      respond({ type: 'response', request_id, status: 'error', message: err.message });
    }
  }

  async function handleStopRequest(msg, respond, socket) {
    const { session_id, transcript_path, cwd, request_id } = msg;

    if (!config.alwaysEnabled && !registry.isAfkEnabled(session_id)) {
      respond({ type: 'response', request_id, status: 'not_enabled' });
      return;
    }

    if (!telegram.isConfigured() || !state.chatId) {
      respond({ type: 'response', request_id, status: 'not_configured' });
      return;
    }

    const claudeContext = await getLastClaudeMessage(transcript_path, { maxLength: 500 });
    const projectSlug = path.basename(cwd || '.') || 'project';
    const token = registry.register(session_id, projectSlug);

    let notificationText = `[${projectSlug}] #${token}\n\n`;
    if (claudeContext) {
      notificationText += `${claudeContext}\n\n`;
    }
    notificationText += `Task complete. Reply with follow-up instructions or ignore to stop.`;

    try {
      const result = await telegram.sendMessage(state.chatId, notificationText);

      // Track socket with timeout
      const timeout = setTimeout(() => {
        waitingSockets.delete(result.message_id);
        respond({ type: 'response', request_id, status: 'stop' });
      }, config.stopFollowupTimeout * 1000);

      waitingSockets.set(result.message_id, {
        respond,
        requestId: request_id,
        sessionId: session_id,
        type: 'stop',
        timeout
      });

    } catch (err) {
      respond({ type: 'response', request_id, status: 'error', message: err.message });
    }
  }

  /**
   * Process Telegram updates (for testing)
   */
  async function processUpdates() {
    const updates = await telegram.getUpdates(0);

    for (const update of updates) {
      if (!update.message) continue;

      const msg = update.message;
      const chatId = msg.chat?.id;
      const text = msg.text?.trim();

      // Handle /start
      if (text === '/start' && chatId) {
        state.chatId = chatId;
        await telegram.sendMessage(chatId, 'Claude AFK paired!');
        continue;
      }

      // Only process from paired chat
      if (chatId !== state.chatId) continue;

      // Check reply-to
      const replyToMessageId = msg.reply_to_message?.message_id;
      if (!replyToMessageId) continue;

      const waiting = waitingSockets.get(replyToMessageId);
      if (!waiting) continue;

      // Clear timeout if present
      if (waiting.timeout) {
        clearTimeout(waiting.timeout);
      }

      waitingSockets.delete(replyToMessageId);

      if (waiting.type === 'permission') {
        const normalized = text.toLowerCase();
        if (normalized === 'yes' || normalized === 'y') {
          registry.removePendingByMessageId(replyToMessageId);
          waiting.respond({ type: 'response', request_id: waiting.requestId, status: 'approved' });
        } else if (normalized === 'no' || normalized === 'n') {
          registry.removePendingByMessageId(replyToMessageId);
          waiting.respond({ type: 'response', request_id: waiting.requestId, status: 'denied', message: 'User denied' });
        } else {
          // Invalid - put back
          waitingSockets.set(replyToMessageId, waiting);
        }
      } else if (waiting.type === 'stop') {
        let instructions = text;
        if (instructions.length > 2000) {
          instructions = instructions.substring(0, 1997) + '...';
        }
        waiting.respond({ type: 'response', request_id: waiting.requestId, status: 'continue', instructions });
      }
    }
  }

  return {
    pipePath,
    telegram,
    registry,
    state,
    config,

    async start() {
      server.onMessage(handleRequest);
      await server.start();
      running = true;
    },

    async stop() {
      if (!running) return;
      running = false;

      // Clear all timeouts
      for (const [, waiting] of waitingSockets) {
        if (waiting.timeout) clearTimeout(waiting.timeout);
      }
      waitingSockets.clear();

      await server.stop();
    },

    processUpdates,

    setChatId(chatId) {
      state.chatId = chatId;
    }
  };
}

// Tests
describe('Integration: Full Permission Flow', () => {
  let daemon;
  let client;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('user approves permission via Telegram', async () => {
    // 1. Start daemon with mocked Telegram
    daemon = createTestDaemon({ chatId: 12345 });
    await daemon.start();

    // 2. Enable AFK mode for session
    client = await createIPCClient(daemon.pipePath);
    const enableResult = await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-001'
    });
    assert.strictEqual(enableResult.status, 'enabled');

    // 3. Send permission request
    const requestPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'req-perm-1',
      session_id: 'test-session-001',
      tool_name: 'Bash',
      message: 'npm run test',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/home/user/my-app'
    });

    // Wait for message to be sent
    await new Promise(r => setTimeout(r, 50));

    // 4. Verify notification was sent
    const sentMessage = daemon.telegram.getLastSentMessage();
    assert.ok(sentMessage, 'Notification should be sent');
    assert.ok(sentMessage.text.includes('Permission: Bash'), 'Should include tool name');
    assert.ok(sentMessage.text.includes('npm run test'), 'Should include command');

    // 5. Simulate user reply
    daemon.telegram.simulateReply('yes', sentMessage.message_id, 12345);
    await daemon.processUpdates();

    // 6. Verify output
    const response = await requestPromise;
    assert.strictEqual(response.status, 'approved');
  });

  it('user denies permission via Telegram', async () => {
    daemon = createTestDaemon({ chatId: 12345 });
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-002'
    });

    const requestPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'req-perm-2',
      session_id: 'test-session-002',
      tool_name: 'Write',
      message: 'Write to /etc/hosts',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    await new Promise(r => setTimeout(r, 50));

    const sentMessage = daemon.telegram.getLastSentMessage();
    daemon.telegram.simulateReply('no', sentMessage.message_id, 12345);
    await daemon.processUpdates();

    const response = await requestPromise;
    assert.strictEqual(response.status, 'denied');
    assert.ok(response.message.includes('denied'));
  });

  it('returns not_enabled when AFK mode is off', async () => {
    daemon = createTestDaemon({ chatId: 12345 });
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);

    // Don't enable AFK mode
    const response = await client.sendAndWait({
      type: 'permission_request',
      request_id: 'req-perm-3',
      session_id: 'test-session-003',
      tool_name: 'Bash',
      message: 'ls',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    assert.strictEqual(response.status, 'not_enabled');
  });

  it('returns not_configured when no chat ID', async () => {
    daemon = createTestDaemon({ chatId: null }); // No chat ID configured
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-004'
    });

    const response = await client.sendAndWait({
      type: 'permission_request',
      request_id: 'req-perm-4',
      session_id: 'test-session-004',
      tool_name: 'Bash',
      message: 'rm -rf /',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    assert.strictEqual(response.status, 'not_configured');
  });

  it('includes Claude context in notification', async () => {
    daemon = createTestDaemon({ chatId: 12345 });
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-005'
    });

    const requestPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'req-perm-5',
      session_id: 'test-session-005',
      tool_name: 'Bash',
      message: 'npm test',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/home/user/my-app'
    });

    await new Promise(r => setTimeout(r, 50));

    const sentMessage = daemon.telegram.getLastSentMessage();
    // Should include content from the transcript
    assert.ok(sentMessage.text.includes('fixed the authentication bug'), 'Should include Claude context');

    // Clean up
    daemon.telegram.simulateReply('yes', sentMessage.message_id, 12345);
    await daemon.processUpdates();
    await requestPromise;
  });
});

describe('Integration: Stop Flow', () => {
  let daemon;
  let client;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('user provides follow-up instructions', async () => {
    daemon = createTestDaemon({ chatId: 12345, stopFollowupTimeout: 5 });
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-stop-1'
    });

    const requestPromise = client.sendAndWait({
      type: 'stop_request',
      request_id: 'req-stop-1',
      session_id: 'test-session-stop-1',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/home/user/my-app'
    });

    await new Promise(r => setTimeout(r, 50));

    const sentMessage = daemon.telegram.getLastSentMessage();
    assert.ok(sentMessage.text.includes('Task complete'), 'Should notify task complete');

    // User provides follow-up
    daemon.telegram.simulateReply('now run the linter', sentMessage.message_id, 12345);
    await daemon.processUpdates();

    const response = await requestPromise;
    assert.strictEqual(response.status, 'continue');
    assert.strictEqual(response.instructions, 'now run the linter');
  });

  it('times out when no follow-up provided', async () => {
    daemon = createTestDaemon({
      chatId: 12345,
      stopFollowupTimeout: 1 // 1 second for fast test
    });
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-stop-2'
    });

    const response = await client.sendAndWait({
      type: 'stop_request',
      request_id: 'req-stop-2',
      session_id: 'test-session-stop-2',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    // Should timeout and return stop
    assert.strictEqual(response.status, 'stop');
  });
});

describe('Integration: Status Command', () => {
  let daemon;
  let client;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('returns daemon status', async () => {
    daemon = createTestDaemon({ chatId: 12345 });
    await daemon.start();

    client = await createIPCClient(daemon.pipePath);

    // Enable a session
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'req-enable',
      session_id: 'test-session-status'
    });

    const response = await client.sendAndWait({
      type: 'status',
      request_id: 'req-status'
    });

    assert.strictEqual(response.status, 'status_response');
    assert.strictEqual(response.daemon_running, true);
    assert.strictEqual(response.telegram_configured, true);
    assert.strictEqual(response.chat_id_configured, true);
    assert.ok(response.afk_sessions.includes('test-session-status'));
  });
});

describe('Integration: Telegram Pairing', () => {
  let daemon;
  let client;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('pairs when user sends /start', async () => {
    daemon = createTestDaemon({ chatId: null }); // Not paired yet
    await daemon.start();

    // Simulate /start
    daemon.telegram.simulateStart(98765);
    await daemon.processUpdates();

    // Chat ID should be set
    assert.strictEqual(daemon.state.chatId, 98765);

    // Should send confirmation
    const messages = daemon.telegram.getSentMessages();
    assert.ok(messages.some(m => m.text.includes('paired')));
  });
});
