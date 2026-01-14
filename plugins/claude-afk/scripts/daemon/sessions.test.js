// Session registry tests - TDD approach
// Tests for session management and token generation

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createSessionRegistry } = require('./sessions.js');

describe('session registry', () => {
  let registry;

  beforeEach(() => {
    registry = createSessionRegistry();
  });

  it('generates unique tokens for each session', () => {
    const token1 = registry.register('session-1', 'my-app');
    const token2 = registry.register('session-2', 'my-app');

    assert.notStrictEqual(token1, token2);
    assert.match(token1, /^my-app-[a-z0-9]{4}$/);
    assert.match(token2, /^my-app-[a-z0-9]{4}$/);
  });

  it('retrieves session by token', () => {
    const token = registry.register('session-abc', 'project');

    const session = registry.getByToken(token);
    assert.strictEqual(session.sessionId, 'session-abc');
  });

  it('retrieves session by session_id', () => {
    const token = registry.register('session-xyz', 'my-project');

    const session = registry.getBySessionId('session-xyz');
    assert.strictEqual(session.token, token);
    assert.strictEqual(session.projectSlug, 'my-project');
  });

  it('returns null for unknown token', () => {
    const session = registry.getByToken('unknown-xxxx');
    assert.strictEqual(session, null);
  });

  it('returns null for unknown session_id', () => {
    const session = registry.getBySessionId('unknown-session');
    assert.strictEqual(session, null);
  });

  it('enables AFK mode for session', () => {
    registry.register('session-1', 'app');

    registry.enableAfk('session-1');

    assert.strictEqual(registry.isAfkEnabled('session-1'), true);
  });

  it('disables AFK mode for session', () => {
    registry.register('session-1', 'app');
    registry.enableAfk('session-1');

    registry.disableAfk('session-1');

    assert.strictEqual(registry.isAfkEnabled('session-1'), false);
  });

  it('lists all AFK-enabled sessions', () => {
    registry.register('session-1', 'app');
    registry.register('session-2', 'app');
    registry.register('session-3', 'app');

    registry.enableAfk('session-1');
    registry.enableAfk('session-3');

    const enabled = registry.getAfkEnabledSessions();
    assert.deepStrictEqual(enabled.sort(), ['session-1', 'session-3'].sort());
  });

  it('tracks pending requests with message IDs', () => {
    registry.register('session-1', 'app');
    registry.addPendingRequest('session-1', {
      messageId: 123,
      tool: 'Bash',
      command: 'npm test',
      requestId: 'req-1'
    });

    const pending = registry.getPendingByMessageId(123);
    assert.strictEqual(pending.sessionId, 'session-1');
    assert.strictEqual(pending.tool, 'Bash');
  });

  it('returns null for unknown message ID', () => {
    const pending = registry.getPendingByMessageId(999);
    assert.strictEqual(pending, null);
  });

  it('removes pending request', () => {
    registry.register('session-1', 'app');
    registry.addPendingRequest('session-1', { messageId: 123, tool: 'Bash' });

    registry.removePendingByMessageId(123);

    const pending = registry.getPendingByMessageId(123);
    assert.strictEqual(pending, null);
  });

  it('gets pending request by session and tool', () => {
    registry.register('session-1', 'app');
    registry.addPendingRequest('session-1', {
      messageId: 123,
      tool: 'Bash',
      command: 'npm test',
      retryCount: 0
    });

    const pending = registry.getPendingBySessionAndTool('session-1', 'Bash', 'npm test');
    assert.strictEqual(pending.messageId, 123);
  });

  it('increments retry count on existing pending request', () => {
    registry.register('session-1', 'app');
    registry.addPendingRequest('session-1', {
      messageId: 123,
      tool: 'Bash',
      command: 'npm test',
      retryCount: 0
    });

    registry.incrementRetryCount('session-1', 'Bash', 'npm test');

    const pending = registry.getPendingBySessionAndTool('session-1', 'Bash', 'npm test');
    assert.strictEqual(pending.retryCount, 1);
  });

  it('slugifies project name correctly', () => {
    const token = registry.register('session-1', 'My Project Name');
    assert.match(token, /^my-project-name-[a-z0-9]{4}$/);
  });

  it('handles special characters in project name', () => {
    const token = registry.register('session-1', 'my_project@2.0');
    assert.match(token, /^my-project-2-0-[a-z0-9]{4}$/);
  });

  it('unregisters session', () => {
    const token = registry.register('session-1', 'app');
    registry.enableAfk('session-1');

    registry.unregister('session-1');

    assert.strictEqual(registry.getBySessionId('session-1'), null);
    assert.strictEqual(registry.getByToken(token), null);
    assert.strictEqual(registry.isAfkEnabled('session-1'), false);
  });

  it('counts pending requests', () => {
    registry.register('session-1', 'app');
    registry.register('session-2', 'app');

    registry.addPendingRequest('session-1', { messageId: 1, tool: 'Bash' });
    registry.addPendingRequest('session-1', { messageId: 2, tool: 'Edit' });
    registry.addPendingRequest('session-2', { messageId: 3, tool: 'Bash' });

    assert.strictEqual(registry.getPendingCount(), 3);
  });

  it('exports state for persistence', () => {
    registry.register('session-1', 'app');
    registry.enableAfk('session-1');
    registry.addPendingRequest('session-1', { messageId: 123, tool: 'Bash', command: 'test' });

    const state = registry.exportState();

    assert.ok(Array.isArray(state.afkSessions));
    assert.ok(state.afkSessions.includes('session-1'));
    assert.ok(state.pendingRequests['session-1']);
  });

  it('imports state from persistence', () => {
    const state = {
      afkSessions: ['session-1', 'session-2'],
      pendingRequests: {
        'session-1': { messageId: 123, tool: 'Bash', command: 'test', retryCount: 1 }
      }
    };

    registry.importState(state);

    assert.strictEqual(registry.isAfkEnabled('session-1'), true);
    assert.strictEqual(registry.isAfkEnabled('session-2'), true);
    // Note: pending requests are imported but sessions need to be re-registered
  });
});
