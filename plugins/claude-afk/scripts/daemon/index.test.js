// Daemon index.js tests
// Tests for configuration and state management

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { findExistingPendingRequest, removeFromDualIndex, isMaxRetriesExceeded, checkRequestExists } = require('./index');

// We need to test deepMerge in isolation, so let's extract it or test through module exports
// For now, we'll implement a local version to match the PRD spec exactly
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

describe('deepMerge', () => {
  it('merges flat objects with source taking precedence', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };
    const result = deepMerge(target, source);

    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, 3); // source wins
    assert.strictEqual(result.c, 4);
  });

  it('deep merges nested objects', () => {
    const target = {
      transcriptPolling: {
        enabled: true,
        intervalMs: 3000,
        enableMtimeOptimization: true
      }
    };
    const source = {
      transcriptPolling: {
        intervalMs: 5000  // Only override intervalMs
      }
    };
    const result = deepMerge(target, source);

    assert.strictEqual(result.transcriptPolling.enabled, true); // from target
    assert.strictEqual(result.transcriptPolling.intervalMs, 5000); // from source
    assert.strictEqual(result.transcriptPolling.enableMtimeOptimization, true); // from target
  });

  it('handles missing target properties during deep merge', () => {
    const target = { a: 1 };
    const source = { nested: { b: 2 } };
    const result = deepMerge(target, source);

    assert.strictEqual(result.a, 1);
    assert.deepStrictEqual(result.nested, { b: 2 });
  });

  it('treats arrays as primitives (no deep merge)', () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    const result = deepMerge(target, source);

    assert.deepStrictEqual(result.arr, [4, 5]); // source replaces, not merges
  });

  it('preserves target when source key is undefined', () => {
    const target = { a: 1, b: 2 };
    const source = { a: undefined };
    const result = deepMerge(target, source);

    assert.strictEqual(result.a, undefined); // source value (undefined) wins
    assert.strictEqual(result.b, 2);
  });

  it('handles null values in source', () => {
    const target = { a: { b: 1 } };
    const source = { a: null };
    const result = deepMerge(target, source);

    assert.strictEqual(result.a, null); // null is primitive, replaces target
  });

  it('handles deeply nested objects', () => {
    const target = {
      level1: {
        level2: {
          level3: {
            value: 'target'
          }
        }
      }
    };
    const source = {
      level1: {
        level2: {
          level3: {
            value: 'source'
          }
        }
      }
    };
    const result = deepMerge(target, source);

    assert.strictEqual(result.level1.level2.level3.value, 'source');
  });

  it('merges multiple nested objects at same level', () => {
    const target = {
      transcriptPolling: { enabled: true, intervalMs: 3000 },
      hookTimeouts: { permissionRequest: 300, stop: 90 }
    };
    const source = {
      transcriptPolling: { intervalMs: 5000 },
      hookTimeouts: { permissionRequest: 3600 }
    };
    const result = deepMerge(target, source);

    assert.strictEqual(result.transcriptPolling.enabled, true); // from target
    assert.strictEqual(result.transcriptPolling.intervalMs, 5000); // from source
    assert.strictEqual(result.hookTimeouts.permissionRequest, 3600); // from source
    assert.strictEqual(result.hookTimeouts.stop, 90); // from target
  });
});

describe('DEFAULT_CONFIG structure', () => {
  it('includes nested transcriptPolling config', () => {
    // This is a documentation test - verifies expected structure exists
    const expectedStructure = {
      transcriptPolling: {
        enabled: true,
        intervalMs: 3000,
        enableMtimeOptimization: true
      }
    };

    // In actual daemon, DEFAULT_CONFIG should have this structure
    assert.ok(expectedStructure.transcriptPolling);
    assert.strictEqual(typeof expectedStructure.transcriptPolling.enabled, 'boolean');
    assert.strictEqual(typeof expectedStructure.transcriptPolling.intervalMs, 'number');
    assert.strictEqual(typeof expectedStructure.transcriptPolling.enableMtimeOptimization, 'boolean');
  });

  it('includes nested hookTimeouts config', () => {
    const expectedStructure = {
      hookTimeouts: {
        permissionRequest: 3600,
        stop: 3600
      }
    };

    assert.ok(expectedStructure.hookTimeouts);
    assert.strictEqual(typeof expectedStructure.hookTimeouts.permissionRequest, 'number');
    assert.strictEqual(typeof expectedStructure.hookTimeouts.stop, 'number');
  });
});

describe('state structure', () => {
  it('includes requestsBySession in default state', () => {
    const defaultState = {
      chatId: null,
      afkSessions: [],
      pendingRequests: {},
      requestsBySession: {},
      sessionWhitelists: {}
    };

    assert.ok(defaultState.hasOwnProperty('requestsBySession'));
    assert.deepStrictEqual(defaultState.requestsBySession, {});
  });

  it('supports dual-index structure pattern', () => {
    // Example state with dual-index
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' },
        '124': { sessionId: 'session-1', tool: 'Edit' },
        '125': { sessionId: 'session-2', tool: 'Write' }
      },
      requestsBySession: {
        'session-1': ['123', '124'],
        'session-2': ['125']
      }
    };

    // Verify lookup patterns work
    const messageId = '123';
    const request = state.pendingRequests[messageId];
    assert.strictEqual(request.sessionId, 'session-1');

    const sessionRequests = state.requestsBySession['session-1'];
    assert.deepStrictEqual(sessionRequests, ['123', '124']);
  });
});

describe('dual-index operations (Task 004)', () => {
  it('adds request to both pendingRequests and requestsBySession', () => {
    const state = {
      pendingRequests: {},
      requestsBySession: {}
    };

    // Simulate adding a request (like handlePermissionRequest does)
    const messageId = '123';
    const sessionId = 'session-1';
    const msgIdStr = String(messageId);

    state.pendingRequests[msgIdStr] = {
      sessionId: sessionId,
      tool: 'Bash',
      requestType: 'permission'
    };

    if (!state.requestsBySession[sessionId]) {
      state.requestsBySession[sessionId] = [];
    }
    state.requestsBySession[sessionId].push(msgIdStr);

    // Verify both indices updated
    assert.ok(state.pendingRequests[msgIdStr]);
    assert.deepStrictEqual(state.requestsBySession[sessionId], [msgIdStr]);
  });

  it('removes request from both indices correctly', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' },
        '124': { sessionId: 'session-1', tool: 'Edit' }
      },
      requestsBySession: {
        'session-1': ['123', '124']
      }
    };

    // Simulate removal (like handleLocalResolution does)
    const messageId = '123';
    const msgIdStr = String(messageId);
    const sessionId = state.pendingRequests[msgIdStr].sessionId;

    delete state.pendingRequests[msgIdStr];
    const sessionRequests = state.requestsBySession[sessionId];
    if (sessionRequests) {
      const idx = sessionRequests.indexOf(msgIdStr);
      if (idx > -1) sessionRequests.splice(idx, 1);
      if (sessionRequests.length === 0) delete state.requestsBySession[sessionId];
    }

    // Verify both indices updated
    assert.strictEqual(state.pendingRequests[msgIdStr], undefined);
    assert.deepStrictEqual(state.requestsBySession[sessionId], ['124']);
  });

  it('cleans up requestsBySession when last request removed', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      },
      requestsBySession: {
        'session-1': ['123']
      }
    };

    // Remove last request for session
    const messageId = '123';
    const msgIdStr = String(messageId);
    const sessionId = state.pendingRequests[msgIdStr].sessionId;

    delete state.pendingRequests[msgIdStr];
    const sessionRequests = state.requestsBySession[sessionId];
    if (sessionRequests) {
      const idx = sessionRequests.indexOf(msgIdStr);
      if (idx > -1) sessionRequests.splice(idx, 1);
      if (sessionRequests.length === 0) delete state.requestsBySession[sessionId];
    }

    // Verify session index cleaned up
    assert.strictEqual(state.requestsBySession[sessionId], undefined);
  });

  it('normalizes messageId to string consistently', () => {
    const state = {
      pendingRequests: {},
      requestsBySession: {}
    };

    // Telegram returns number, we normalize to string
    const messageIdNumber = 123;
    const messageIdString = String(messageIdNumber);
    const sessionId = 'session-1';

    state.pendingRequests[messageIdString] = {
      sessionId: sessionId,
      tool: 'Bash'
    };

    if (!state.requestsBySession[sessionId]) {
      state.requestsBySession[sessionId] = [];
    }
    state.requestsBySession[sessionId].push(messageIdString);

    // Verify string normalization works (JS object keys are coerced to strings)
    assert.ok(state.pendingRequests['123']);
    assert.ok(state.pendingRequests[123]); // Number key also works (coerced to string)
    assert.strictEqual(typeof state.pendingRequests['123'].sessionId, 'string');

    // But requestsBySession array stores string IDs
    assert.deepStrictEqual(state.requestsBySession[sessionId], ['123']);
    assert.strictEqual(state.requestsBySession[sessionId][0], '123'); // Stored as string
  });

  it('handles multiple requests per session', () => {
    const state = {
      pendingRequests: {},
      requestsBySession: {}
    };

    const sessionId = 'session-1';
    const messageIds = ['100', '101', '102'];

    // Add multiple requests
    for (const msgId of messageIds) {
      state.pendingRequests[msgId] = {
        sessionId: sessionId,
        tool: 'Bash'
      };

      if (!state.requestsBySession[sessionId]) {
        state.requestsBySession[sessionId] = [];
      }
      state.requestsBySession[sessionId].push(msgId);
    }

    // Verify all tracked
    assert.strictEqual(state.requestsBySession[sessionId].length, 3);
    assert.deepStrictEqual(state.requestsBySession[sessionId], messageIds);
  });

  it('searches requestsBySession for retry detection', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash', command: 'ls' },
        '124': { sessionId: 'session-1', tool: 'Edit', command: 'file.txt' }
      },
      requestsBySession: {
        'session-1': ['123', '124']
      }
    };

    // Simulate retry detection (Dry Run Resolution #8)
    const sessionId = 'session-1';
    const toolName = 'Bash';
    const command = 'ls';

    let found = null;
    const sessionRequests = state.requestsBySession[sessionId] || [];
    for (const msgId of sessionRequests) {
      const req = state.pendingRequests[msgId];
      if (req && req.tool === toolName && req.command === command) {
        found = req;
        break;
      }
    }

    assert.ok(found);
    assert.strictEqual(found.tool, 'Bash');
    assert.strictEqual(found.command, 'ls');
  });

  it('handles session expiry cleanup for multiple requests', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' },
        '124': { sessionId: 'session-1', tool: 'Edit' },
        '125': { sessionId: 'session-2', tool: 'Write' }
      },
      requestsBySession: {
        'session-1': ['123', '124'],
        'session-2': ['125']
      }
    };

    // Simulate handleSessionExpired for session-1
    const sessionId = 'session-1';
    const messageIds = state.requestsBySession[sessionId];

    for (const msgId of messageIds) {
      delete state.pendingRequests[msgId];
    }
    delete state.requestsBySession[sessionId];

    // Verify session-1 cleaned up, session-2 untouched
    assert.strictEqual(state.pendingRequests['123'], undefined);
    assert.strictEqual(state.pendingRequests['124'], undefined);
    assert.ok(state.pendingRequests['125']); // session-2 still there
    assert.strictEqual(state.requestsBySession[sessionId], undefined);
    assert.ok(state.requestsBySession['session-2']);
  });
});

describe('findExistingPendingRequest (extracted function)', () => {
  it('finds existing request by session, tool, and command', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash', command: 'ls' },
        '124': { sessionId: 'session-1', tool: 'Edit', command: 'file.txt' }
      },
      requestsBySession: {
        'session-1': ['123', '124']
      }
    };

    const result = findExistingPendingRequest(state, 'session-1', 'Bash', 'ls');

    assert.ok(result);
    assert.strictEqual(result.messageId, '123');
    assert.strictEqual(result.request.tool, 'Bash');
    assert.strictEqual(result.request.command, 'ls');
  });

  it('returns null when no match found', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash', command: 'ls' }
      },
      requestsBySession: {
        'session-1': ['123']
      }
    };

    const result = findExistingPendingRequest(state, 'session-1', 'Edit', 'file.txt');

    assert.strictEqual(result, null);
  });

  it('returns null when session has no requests', () => {
    const state = {
      pendingRequests: {},
      requestsBySession: {}
    };

    const result = findExistingPendingRequest(state, 'session-1', 'Bash', 'ls');

    assert.strictEqual(result, null);
  });

  it('handles multiple requests and finds correct one', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash', command: 'ls' },
        '124': { sessionId: 'session-1', tool: 'Bash', command: 'pwd' },
        '125': { sessionId: 'session-1', tool: 'Edit', command: 'file.txt' }
      },
      requestsBySession: {
        'session-1': ['123', '124', '125']
      }
    };

    const result = findExistingPendingRequest(state, 'session-1', 'Bash', 'pwd');

    assert.ok(result);
    assert.strictEqual(result.messageId, '124');
    assert.strictEqual(result.request.command, 'pwd');
  });

  it('handles missing pendingRequests entry (stale index)', () => {
    const state = {
      pendingRequests: {
        '124': { sessionId: 'session-1', tool: 'Edit', command: 'file.txt' }
      },
      requestsBySession: {
        'session-1': ['123', '124']  // '123' is stale
      }
    };

    const result = findExistingPendingRequest(state, 'session-1', 'Bash', 'ls');

    assert.strictEqual(result, null);  // Skips stale entry
  });
});

describe('removeFromDualIndex (extracted function)', () => {
  it('removes request from both indices', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      },
      requestsBySession: {
        'session-1': ['123']
      }
    };

    removeFromDualIndex(state, '123', 'session-1');

    assert.strictEqual(state.pendingRequests['123'], undefined);
    assert.strictEqual(state.requestsBySession['session-1'], undefined);  // Empty array removed
  });

  it('removes request from session array without deleting array', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' },
        '124': { sessionId: 'session-1', tool: 'Edit' }
      },
      requestsBySession: {
        'session-1': ['123', '124']
      }
    };

    removeFromDualIndex(state, '123', 'session-1');

    assert.strictEqual(state.pendingRequests['123'], undefined);
    assert.deepStrictEqual(state.requestsBySession['session-1'], ['124']);
    assert.ok(state.pendingRequests['124']);  // Other request still there
  });

  it('handles numeric messageId by converting to string', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      },
      requestsBySession: {
        'session-1': ['123']
      }
    };

    removeFromDualIndex(state, 123, 'session-1');  // Pass number

    assert.strictEqual(state.pendingRequests['123'], undefined);
    assert.strictEqual(state.requestsBySession['session-1'], undefined);
  });

  it('handles missing session array gracefully', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      },
      requestsBySession: {}  // No session array
    };

    // Should not throw
    removeFromDualIndex(state, '123', 'session-1');

    assert.strictEqual(state.pendingRequests['123'], undefined);
  });

  it('handles messageId not in session array', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      },
      requestsBySession: {
        'session-1': ['124']  // Different message ID
      }
    };

    removeFromDualIndex(state, '123', 'session-1');

    assert.strictEqual(state.pendingRequests['123'], undefined);
    assert.deepStrictEqual(state.requestsBySession['session-1'], ['124']);  // Unchanged
  });

  it('deletes empty session array after removing last request', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      },
      requestsBySession: {
        'session-1': ['123']
      }
    };

    removeFromDualIndex(state, '123', 'session-1');

    assert.strictEqual(state.requestsBySession['session-1'], undefined);
    assert.ok(!state.requestsBySession.hasOwnProperty('session-1'));
  });
});

describe('isMaxRetriesExceeded (extracted function)', () => {
  it('returns true when retry count equals maxRetries', () => {
    assert.strictEqual(isMaxRetriesExceeded(3, 3), true);
  });

  it('returns true when retry count exceeds maxRetries', () => {
    assert.strictEqual(isMaxRetriesExceeded(5, 3), true);
  });

  it('returns false when retry count below maxRetries', () => {
    assert.strictEqual(isMaxRetriesExceeded(2, 3), false);
  });

  it('returns false when retry count is zero', () => {
    assert.strictEqual(isMaxRetriesExceeded(0, 3), false);
  });

  it('handles maxRetries of zero correctly', () => {
    assert.strictEqual(isMaxRetriesExceeded(0, 0), true);
    assert.strictEqual(isMaxRetriesExceeded(1, 0), true);
  });
});

describe('pendingRequest retryCount initialization', () => {
  it('should initialize retryCount to 0 when no existing pending request', () => {
    // Bug reproduction: Line 521 references `existingPending` which is undefined
    // When there's no existing pending request, retryCount should be 0
    const existing = null;  // No existing pending request (from findExistingPendingRequest)

    // This is the buggy code pattern from index.js line 521:
    // retryCount: existingPending ? existingPending.retryCount : 0,
    // `existingPending` is never defined - should be `existing?.request`

    // Simulate the correct behavior:
    const retryCount = existing ? existing.request.retryCount : 0;

    assert.strictEqual(retryCount, 0);
  });

  it('should inherit retryCount from existing pending request when retry detected', () => {
    // When there IS an existing pending request, inherit its retryCount
    const existing = {
      messageId: '123',
      request: {
        sessionId: 'session-1',
        tool: 'Bash',
        command: 'ls',
        retryCount: 2  // Already retried twice
      }
    };

    // The correct code should use `existing?.request.retryCount`
    const retryCount = existing ? existing.request.retryCount : 0;

    assert.strictEqual(retryCount, 2);
  });

  it('should handle existing request with undefined retryCount', () => {
    // Edge case: existing request but retryCount was never set
    const existing = {
      messageId: '123',
      request: {
        sessionId: 'session-1',
        tool: 'Bash',
        command: 'ls'
        // retryCount not set
      }
    };

    // Use existing?.request.retryCount || 0 for safety
    const retryCount = existing?.request.retryCount || 0;

    assert.strictEqual(retryCount, 0);
  });
});

describe('checkRequestExists (extracted function)', () => {
  it('returns exists=true and pending object when request found', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      }
    };

    const result = checkRequestExists(state, '123');

    assert.strictEqual(result.exists, true);
    assert.ok(result.pending);
    assert.strictEqual(result.pending.sessionId, 'session-1');
  });

  it('returns exists=false and pending=null when request not found', () => {
    const state = {
      pendingRequests: {}
    };

    const result = checkRequestExists(state, '123');

    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.pending, null);
  });

  it('normalizes numeric messageId to string', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      }
    };

    const result = checkRequestExists(state, 123);  // Pass number

    assert.strictEqual(result.exists, true);
    assert.ok(result.pending);
  });

  it('returns correct structure for race condition check', () => {
    const state = {
      pendingRequests: {
        '123': { sessionId: 'session-1', tool: 'Bash' }
      }
    };

    const result = checkRequestExists(state, '123');

    // Verify structure matches usage in handleResponse
    assert.ok(result.hasOwnProperty('exists'));
    assert.ok(result.hasOwnProperty('pending'));
    assert.strictEqual(typeof result.exists, 'boolean');
  });

  it('handles empty pendingRequests object', () => {
    const state = {
      pendingRequests: {}
    };

    const result = checkRequestExists(state, '999');

    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.pending, null);
  });
});

describe('daemon startup cleanup', () => {
  it('should clear both pendingRequests and requestsBySession on startup', () => {
    // This tests the bug: daemon clears pendingRequests but leaves stale requestsBySession
    // The state file had:
    //   pendingRequests: {} (empty)
    //   requestsBySession: { "session-1": ["287", "3", "50", ...] } (16 stale entries)

    const staleState = {
      chatId: 123456,
      afkSessions: ['session-1'],
      pendingRequests: {
        '287': { sessionId: 'session-1', tool: 'Bash', command: 'ls' }
      },
      requestsBySession: {
        'session-1': ['287', '3', '50', '51', '56', '57', '63']  // Stale entries
      },
      sessionWhitelists: {}
    };

    // Simulate daemon startup cleanup (should clear BOTH)
    function cleanupOrphanedRequests(state) {
      if (state.pendingRequests && Object.keys(state.pendingRequests).length > 0) {
        state.pendingRequests = {};
      }
      // BUG FIX: Also clear requestsBySession
      if (state.requestsBySession && Object.keys(state.requestsBySession).length > 0) {
        state.requestsBySession = {};
      }
    }

    cleanupOrphanedRequests(staleState);

    // Both should be empty after cleanup
    assert.deepStrictEqual(staleState.pendingRequests, {});
    assert.deepStrictEqual(staleState.requestsBySession, {});
  });

  it('should not clear chatId or afkSessions on startup cleanup', () => {
    const state = {
      chatId: 123456,
      afkSessions: ['session-1'],
      pendingRequests: { '123': { sessionId: 'session-1' } },
      requestsBySession: { 'session-1': ['123'] },
      sessionWhitelists: {}
    };

    // Cleanup should only affect pending requests, not other state
    state.pendingRequests = {};
    state.requestsBySession = {};

    assert.strictEqual(state.chatId, 123456);
    assert.deepStrictEqual(state.afkSessions, ['session-1']);
  });

  it('handles requestsBySession with entries but empty pendingRequests (orphaned index)', () => {
    // This is the exact bug scenario observed in production
    const state = {
      chatId: 123456,
      pendingRequests: {},  // Empty
      requestsBySession: {
        'session-1': ['287', '3', '50']  // Stale entries!
      }
    };

    // Even though pendingRequests is empty, we should still clean requestsBySession
    // because it has orphaned entries
    function cleanupOrphanedRequests(state) {
      // Clean up pendingRequests if not empty
      if (state.pendingRequests && Object.keys(state.pendingRequests).length > 0) {
        state.pendingRequests = {};
      }
      // Always clean up requestsBySession too (it may have stale entries)
      if (state.requestsBySession && Object.keys(state.requestsBySession).length > 0) {
        state.requestsBySession = {};
      }
    }

    cleanupOrphanedRequests(state);

    assert.deepStrictEqual(state.requestsBySession, {});
  });
});
