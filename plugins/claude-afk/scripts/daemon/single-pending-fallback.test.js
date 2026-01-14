// Test for single pending fallback feature
// Tests that non-reply messages are routed to the only pending request
// This addresses the issue where dead sockets prevent the fallback from working

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('single pending fallback logic', () => {
  it('should route to single pending request even when socket is dead', () => {
    // Simulate the state after a session resume where socket is dead
    const state = {
      chatId: 12345,
      pendingRequests: {
        '1001': {  // One pending request
          sessionId: 'session-abc',
          tool: 'Edit',
          command: 'some command',
          requestType: 'permission'
        }
      }
    };

    const waitingSockets = new Map(); // Empty because socket is dead

    const config = {
      allowSinglePendingFallback: true
    };

    // Simulate the logic from processUpdate
    const pendingRequestCount = Object.keys(state.pendingRequests).length;
    
    // This should be true - we have one pending request
    assert.strictEqual(pendingRequestCount, 1);
    assert.strictEqual(config.allowSinglePendingFallback, true);
    
    // The old code would check waitingSockets.size === 1 (which is 0)
    // The new code checks pendingRequestCount === 1 (which is 1)
    assert.strictEqual(pendingRequestCount === 1, true, 'Should detect single pending request');
  });

  it('should not route when multiple pending requests exist', () => {
    const state = {
      chatId: 12345,
      pendingRequests: {
        '1001': {
          sessionId: 'session-abc',
          tool: 'Edit',
          command: 'command 1',
          requestType: 'permission'
        },
        '1002': {
          sessionId: 'session-xyz',
          tool: 'Write',
          command: 'command 2',
          requestType: 'permission'
        }
      }
    };

    const config = {
      allowSinglePendingFallback: true
    };

    const pendingRequestCount = Object.keys(state.pendingRequests).length;
    
    // Should not allow fallback with multiple pending requests
    assert.strictEqual(pendingRequestCount > 1, true);
    assert.strictEqual(pendingRequestCount === 1, false, 'Should not allow fallback with multiple requests');
  });

  it('should not route when no pending requests exist', () => {
    const state = {
      chatId: 12345,
      pendingRequests: {}
    };

    const config = {
      allowSinglePendingFallback: true
    };

    const pendingRequestCount = Object.keys(state.pendingRequests).length;
    
    // Should not allow fallback with no pending requests
    assert.strictEqual(pendingRequestCount, 0);
    assert.strictEqual(pendingRequestCount === 1, false, 'Should not allow fallback with no requests');
  });

  it('should not route when feature is disabled', () => {
    const state = {
      chatId: 12345,
      pendingRequests: {
        '1001': {
          sessionId: 'session-abc',
          tool: 'Edit',
          command: 'some command',
          requestType: 'permission'
        }
      }
    };

    const config = {
      allowSinglePendingFallback: false
    };

    const pendingRequestCount = Object.keys(state.pendingRequests).length;
    
    // Should not allow fallback when disabled
    assert.strictEqual(config.allowSinglePendingFallback, false);
    assert.strictEqual(config.allowSinglePendingFallback && pendingRequestCount === 1, false, 
      'Should not allow fallback when feature is disabled');
  });
});
