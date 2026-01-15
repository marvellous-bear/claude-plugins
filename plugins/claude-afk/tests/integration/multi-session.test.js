// Integration test: Multi-session support
// Tests concurrent sessions with independent AFK states
//
// PRD Reference (lines 1648-1671):
// - Multiple hooks fire rapidly
// - Out-of-order approvals supported
// - Each hook only unblocks when its specific message gets a reply

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createIPCServer, createIPCClient } = require('../../scripts/daemon/ipc');
const { createSessionRegistry } = require('../../scripts/daemon/sessions');
const { getLastClaudeMessage } = require('../../scripts/daemon/transcript');

// Test fixture path
const FIXTURE_TRANSCRIPT = path.join(__dirname, '..', 'fixtures', 'sample-transcript.jsonl');

/**
 * Create a mock Telegram client for multi-session testing
 */
function createTelegramMock() {
  const sentMessages = [];
  const replies = [];
  let messageIdCounter = 2000;
  let updateIdCounter = 100;

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

    getSentMessages: () => [...sentMessages],
    getLastSentMessage: () => sentMessages[sentMessages.length - 1],
    getMessageById: (id) => sentMessages.find(m => m.message_id === id),

    simulateReply(text, replyToMessageId, chatId = 12345) {
      replies.push({ text, replyTo: replyToMessageId, chatId });
    },

    // Simulate a non-reply message (for testing single-pending fallback)
    simulateMessage(text, chatId = 12345) {
      replies.push({ text, replyTo: null, chatId });
    }
  };
}

/**
 * Create test daemon for multi-session testing
 */
function createTestDaemon(options = {}) {
  const pipePath = options.pipePath || path.join(os.tmpdir(), `claude-afk-multi-${Date.now()}.sock`);
  const telegram = options.telegram || createTelegramMock();
  const registry = createSessionRegistry();
  const config = { alwaysEnabled: false, maxRetries: 3, stopFollowupTimeout: 2, allowSinglePendingFallback: true };

  // Extended state to track terminal_id for orphan cleanup testing
  let state = { chatId: options.chatId || 12345, afkSessions: [], pendingRequests: {}, requestsBySession: {} };
  const server = createIPCServer(pipePath);
  const waitingSockets = new Map();
  let running = false;

  /**
   * Clean up orphaned requests from other sessions using the same terminal
   */
  function cleanupOrphanedTerminalRequests(terminalId, currentSessionId) {
    if (!terminalId) return;

    const orphanedMessageIds = [];
    for (const [messageId, request] of Object.entries(state.pendingRequests)) {
      if (request.terminalId === terminalId && request.sessionId !== currentSessionId) {
        orphanedMessageIds.push(messageId);
      }
    }

    for (const messageId of orphanedMessageIds) {
      const numericId = Number(messageId);
      waitingSockets.delete(numericId);
      registry.removePendingByMessageId(numericId);
      delete state.pendingRequests[messageId];
      // Clean up requestsBySession
      for (const [sessId, msgIds] of Object.entries(state.requestsBySession)) {
        const idx = msgIds.indexOf(messageId);
        if (idx > -1) {
          msgIds.splice(idx, 1);
          if (msgIds.length === 0) delete state.requestsBySession[sessId];
        }
      }
    }
  }

  function handleRequest(msg, respond, socket) {
    switch (msg.type) {
      case 'enable_afk':
        registry.enableAfk(msg.session_id);
        respond({ type: 'response', request_id: msg.request_id, status: 'enabled' });
        break;

      case 'disable_afk':
        registry.disableAfk(msg.session_id);
        respond({ type: 'response', request_id: msg.request_id, status: 'disabled' });
        break;

      case 'permission_request':
        handlePermissionRequest(msg, respond);
        break;

      case 'status':
        respond({
          type: 'response',
          request_id: msg.request_id,
          status: 'status_response',
          daemon_running: true,
          afk_sessions: registry.getAfkEnabledSessions(),
          pending_requests: registry.getPendingCount()
        });
        break;

      default:
        respond({ type: 'response', request_id: msg.request_id, status: 'error' });
    }
  }

  async function handlePermissionRequest(msg, respond) {
    const { session_id, terminal_id, tool_name, message, transcript_path, cwd, request_id } = msg;

    if (!registry.isAfkEnabled(session_id)) {
      respond({ type: 'response', request_id, status: 'not_enabled' });
      return;
    }

    if (!state.chatId) {
      respond({ type: 'response', request_id, status: 'not_configured' });
      return;
    }

    // Clean up orphaned requests from previous sessions on this terminal
    cleanupOrphanedTerminalRequests(terminal_id, session_id);

    const claudeContext = await getLastClaudeMessage(transcript_path, { maxLength: 500 });
    const projectSlug = path.basename(cwd || '.') || 'project';
    const token = registry.register(session_id, projectSlug);

    let notificationText = `[${projectSlug}] #${token}\n\n`;
    if (claudeContext) notificationText += `${claudeContext}\n\n`;
    notificationText += `Permission: ${tool_name}\n> ${message}\n\nReply: yes / no`;

    try {
      const result = await telegram.sendMessage(state.chatId, notificationText);

      registry.addPendingRequest(session_id, {
        messageId: result.message_id,
        tool: tool_name,
        command: message,
        requestId: request_id
      });

      // Track in state with terminal_id for orphan detection
      const msgIdStr = String(result.message_id);
      state.pendingRequests[msgIdStr] = {
        sessionId: session_id,
        terminalId: terminal_id,
        tool: tool_name,
        command: message
      };
      if (!state.requestsBySession[session_id]) {
        state.requestsBySession[session_id] = [];
      }
      state.requestsBySession[session_id].push(msgIdStr);

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

  async function processUpdates() {
    const updates = await telegram.getUpdates(0);

    for (const update of updates) {
      if (!update.message) continue;

      const msg = update.message;
      const chatId = msg.chat?.id;
      const text = msg.text?.trim();

      if (chatId !== state.chatId) continue;

      const replyToMessageId = msg.reply_to_message?.message_id;

      // Handle non-reply messages with single-pending fallback
      if (!replyToMessageId) {
        if (config.allowSinglePendingFallback && waitingSockets.size === 1) {
          // Route to the only pending request
          const [[messageId, waiting]] = waitingSockets.entries();
          handleResponse(messageId, waiting, text);
        }
        continue;
      }

      const waiting = waitingSockets.get(replyToMessageId);
      if (!waiting) continue;

      handleResponse(replyToMessageId, waiting, text);
    }
  }

  function handleResponse(messageId, waiting, text) {
    waitingSockets.delete(messageId);

    // Clean up state tracking
    const msgIdStr = String(messageId);
    delete state.pendingRequests[msgIdStr];
    if (state.requestsBySession[waiting.sessionId]) {
      const idx = state.requestsBySession[waiting.sessionId].indexOf(msgIdStr);
      if (idx > -1) state.requestsBySession[waiting.sessionId].splice(idx, 1);
    }

    if (waiting.type === 'permission') {
      const normalized = text.toLowerCase();
      if (normalized === 'yes' || normalized === 'y') {
        registry.removePendingByMessageId(messageId);
        waiting.respond({ type: 'response', request_id: waiting.requestId, status: 'approved' });
      } else if (normalized === 'no' || normalized === 'n') {
        registry.removePendingByMessageId(messageId);
        waiting.respond({ type: 'response', request_id: waiting.requestId, status: 'denied' });
      }
    }
  }

  return {
    pipePath,
    telegram,
    registry,
    state,

    async start() {
      server.onMessage(handleRequest);
      await server.start();
      running = true;
    },

    async stop() {
      if (!running) return;
      running = false;
      waitingSockets.clear();
      await server.stop();
    },

    processUpdates,
    getWaitingCount: () => waitingSockets.size
  };
}

// Tests
describe('Integration: Multiple Sessions', () => {
  let daemon;
  let clients = [];

  afterEach(async () => {
    for (const client of clients) {
      await client.close();
    }
    clients = [];
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('handles multiple sessions independently', async () => {
    daemon = createTestDaemon();
    await daemon.start();

    // Create two clients (simulating two terminal sessions)
    const client1 = await createIPCClient(daemon.pipePath);
    const client2 = await createIPCClient(daemon.pipePath);
    clients.push(client1, client2);

    // Enable AFK for session 1 only
    await client1.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-1',
      session_id: 'session-A'
    });

    // Session 1: Should work (AFK enabled)
    const perm1Promise = client1.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-1',
      session_id: 'session-A',
      tool_name: 'Bash',
      message: 'npm test',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project-a'
    });

    await new Promise(r => setTimeout(r, 50));

    // Session 2: Should return not_enabled
    const perm2 = await client2.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-2',
      session_id: 'session-B',
      tool_name: 'Bash',
      message: 'npm build',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project-b'
    });

    assert.strictEqual(perm2.status, 'not_enabled', 'Session B should not be enabled');

    // Approve session 1
    const sentMessage = daemon.telegram.getLastSentMessage();
    daemon.telegram.simulateReply('yes', sentMessage.message_id);
    await daemon.processUpdates();

    const perm1 = await perm1Promise;
    assert.strictEqual(perm1.status, 'approved', 'Session A should be approved');
  });

  it('routes replies to correct waiting session', async () => {
    daemon = createTestDaemon();
    await daemon.start();

    const client1 = await createIPCClient(daemon.pipePath);
    const client2 = await createIPCClient(daemon.pipePath);
    clients.push(client1, client2);

    // Enable both sessions
    await client1.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-1',
      session_id: 'session-A'
    });

    await client2.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-2',
      session_id: 'session-B'
    });

    // Both sessions request permission
    const perm1Promise = client1.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-A',
      session_id: 'session-A',
      tool_name: 'Bash',
      message: 'git push',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project-a'
    });

    await new Promise(r => setTimeout(r, 30));

    const perm2Promise = client2.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-B',
      session_id: 'session-B',
      tool_name: 'Write',
      message: 'config.json',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project-b'
    });

    await new Promise(r => setTimeout(r, 30));

    // Get both message IDs
    const messages = daemon.telegram.getSentMessages();
    assert.strictEqual(messages.length, 2, 'Should have sent 2 notifications');

    const msg1 = messages.find(m => m.text.includes('git push'));
    const msg2 = messages.find(m => m.text.includes('config.json'));

    assert.ok(msg1, 'Should find git push message');
    assert.ok(msg2, 'Should find config.json message');

    // Reply to session B first (out of order)
    daemon.telegram.simulateReply('no', msg2.message_id);
    await daemon.processUpdates();

    const perm2 = await perm2Promise;
    assert.strictEqual(perm2.status, 'denied', 'Session B should be denied');

    // Session A should still be waiting
    assert.strictEqual(daemon.getWaitingCount(), 1, 'Session A should still be waiting');

    // Now reply to session A
    daemon.telegram.simulateReply('yes', msg1.message_id);
    await daemon.processUpdates();

    const perm1 = await perm1Promise;
    assert.strictEqual(perm1.status, 'approved', 'Session A should be approved');
  });

  it('handles rapid requests from same session', async () => {
    daemon = createTestDaemon();
    await daemon.start();

    const client = await createIPCClient(daemon.pipePath);
    clients.push(client);

    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable',
      session_id: 'rapid-session'
    });

    // Send multiple requests rapidly
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(client.sendAndWait({
        type: 'permission_request',
        request_id: `perm-${i}`,
        session_id: 'rapid-session',
        tool_name: 'Bash',
        message: `command-${i}`,
        transcript_path: FIXTURE_TRANSCRIPT,
        cwd: '/project'
      }));
      await new Promise(r => setTimeout(r, 20));
    }

    // Should have 3 notifications
    const messages = daemon.telegram.getSentMessages();
    assert.strictEqual(messages.length, 3, 'Should send 3 notifications');

    // Reply to all in reverse order
    for (let i = 2; i >= 0; i--) {
      const msg = messages.find(m => m.text.includes(`command-${i}`));
      daemon.telegram.simulateReply('yes', msg.message_id);
      await daemon.processUpdates();
    }

    // All should resolve
    const results = await Promise.all(promises);
    assert.ok(results.every(r => r.status === 'approved'), 'All should be approved');
  });

  it('tracks pending requests correctly across sessions', async () => {
    daemon = createTestDaemon();
    await daemon.start();

    const client = await createIPCClient(daemon.pipePath);
    clients.push(client);

    // Enable session
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable',
      session_id: 'track-session'
    });

    // Check initial status
    let status = await client.sendAndWait({
      type: 'status',
      request_id: 'status-1'
    });
    assert.strictEqual(status.pending_requests, 0);

    // Send a request
    const permPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-track',
      session_id: 'track-session',
      tool_name: 'Bash',
      message: 'pending-test',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    await new Promise(r => setTimeout(r, 50));

    // Check pending count (need separate client since first is waiting)
    const client2 = await createIPCClient(daemon.pipePath);
    clients.push(client2);

    status = await client2.sendAndWait({
      type: 'status',
      request_id: 'status-2'
    });
    assert.strictEqual(status.pending_requests, 1, 'Should have 1 pending request');

    // Resolve request
    const msg = daemon.telegram.getLastSentMessage();
    daemon.telegram.simulateReply('yes', msg.message_id);
    await daemon.processUpdates();
    await permPromise;

    // Check pending count is back to 0
    status = await client2.sendAndWait({
      type: 'status',
      request_id: 'status-3'
    });
    assert.strictEqual(status.pending_requests, 0, 'Should have 0 pending requests');
  });

  it('allows enabling and disabling AFK for different sessions', async () => {
    daemon = createTestDaemon();
    await daemon.start();

    const client = await createIPCClient(daemon.pipePath);
    clients.push(client);

    // Enable session A
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-a',
      session_id: 'session-A'
    });

    // Enable session B
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-b',
      session_id: 'session-B'
    });

    // Check both are enabled
    let status = await client.sendAndWait({
      type: 'status',
      request_id: 'status-1'
    });
    assert.ok(status.afk_sessions.includes('session-A'));
    assert.ok(status.afk_sessions.includes('session-B'));

    // Disable session A
    await client.sendAndWait({
      type: 'disable_afk',
      request_id: 'disable-a',
      session_id: 'session-A'
    });

    // Check only B is enabled
    status = await client.sendAndWait({
      type: 'status',
      request_id: 'status-2'
    });
    assert.ok(!status.afk_sessions.includes('session-A'));
    assert.ok(status.afk_sessions.includes('session-B'));

    // Request from A should fail
    const permA = await client.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-a',
      session_id: 'session-A',
      tool_name: 'Bash',
      message: 'test',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });
    assert.strictEqual(permA.status, 'not_enabled');

    // Request from B should work
    const permBPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-b',
      session_id: 'session-B',
      tool_name: 'Bash',
      message: 'test',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    await new Promise(r => setTimeout(r, 50));
    const msg = daemon.telegram.getLastSentMessage();
    daemon.telegram.simulateReply('yes', msg.message_id);
    await daemon.processUpdates();

    const permB = await permBPromise;
    assert.strictEqual(permB.status, 'approved');
  });

  it('cleans up orphaned requests when session changes on same terminal (race condition fix)', async () => {
    // This test verifies the fix for the bug where:
    // 1. Session A has a pending request on terminal T1
    // 2. User resumes Session B on the same terminal T1
    // 3. Session B makes a permission request
    // 4. Without the fix, waitingSockets.size would be 2, blocking non-reply responses
    // 5. With the fix, Session A's orphaned request is cleaned up first

    daemon = createTestDaemon();
    await daemon.start();

    const client = await createIPCClient(daemon.pipePath);
    clients.push(client);

    // Enable both sessions (simulating the scenario)
    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-a',
      session_id: 'session-A'
    });

    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable-b',
      session_id: 'session-B'
    });

    // Session A makes a request on terminal T1
    const permAPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-a',
      session_id: 'session-A',
      terminal_id: 'terminal-T1',  // Same terminal
      tool_name: 'Bash',
      message: 'session-a-command',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project-a'
    });

    await new Promise(r => setTimeout(r, 50));

    // Verify Session A's request is pending
    assert.strictEqual(daemon.getWaitingCount(), 1, 'Session A should have 1 pending request');

    // Now Session B (resuming on same terminal T1) makes a request
    // This should clean up Session A's orphaned request first
    const permBPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-b',
      session_id: 'session-B',
      terminal_id: 'terminal-T1',  // Same terminal - triggers cleanup
      tool_name: 'Write',
      message: 'session-b-file.txt',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project-b'
    });

    await new Promise(r => setTimeout(r, 50));

    // With the fix, Session A's request should be cleaned up
    // and only Session B's request should be pending
    assert.strictEqual(daemon.getWaitingCount(), 1, 'Should have exactly 1 pending request after cleanup');

    // Verify we can respond without direct reply (single-pending fallback)
    daemon.telegram.simulateMessage('yes');  // Non-reply message
    await daemon.processUpdates();

    const permB = await permBPromise;
    assert.strictEqual(permB.status, 'approved', 'Session B should be approved via non-reply message');
  });

  it('allows non-reply response when only one request is pending', async () => {
    daemon = createTestDaemon();
    await daemon.start();

    const client = await createIPCClient(daemon.pipePath);
    clients.push(client);

    await client.sendAndWait({
      type: 'enable_afk',
      request_id: 'enable',
      session_id: 'single-session'
    });

    // Make a single permission request
    const permPromise = client.sendAndWait({
      type: 'permission_request',
      request_id: 'perm-single',
      session_id: 'single-session',
      terminal_id: 'terminal-1',
      tool_name: 'Bash',
      message: 'single-command',
      transcript_path: FIXTURE_TRANSCRIPT,
      cwd: '/project'
    });

    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(daemon.getWaitingCount(), 1);

    // Respond without replying to the notification
    daemon.telegram.simulateMessage('yes');
    await daemon.processUpdates();

    const perm = await permPromise;
    assert.strictEqual(perm.status, 'approved', 'Should approve via non-reply when single pending');
  });
});
