// Permission handler tests - TDD approach
// Tests for PermissionRequest hook handler

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createPermissionHandler, formatApproveOutput, formatDenyOutput } = require('./permission-handler.js');

describe('permission handler', () => {
  describe('handle', () => {
    it('passes through when daemon says not enabled', async () => {
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'not_enabled' }),
          close: async () => {}
        })
      });

      const input = { session_id: 'abc', tool_name: 'Bash', message: 'npm test' };
      const output = await handler.handle(input);

      assert.strictEqual(output, null); // null = passthrough
    });

    it('returns approval when daemon approves', async () => {
      const sentMessages = [];
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            sentMessages.push(msg);
            return { status: 'approved' };
          },
          close: async () => {}
        })
      });

      const input = {
        session_id: 'abc',
        tool_name: 'Bash',
        message: 'npm test',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/project'
      };
      const output = await handler.handle(input);

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].type, 'permission_request');
      assert.strictEqual(sentMessages[0].session_id, 'abc');
      assert.strictEqual(sentMessages[0].tool_name, 'Bash');
      assert.strictEqual(output.hookSpecificOutput.decision.behavior, 'allow');
    });

    it('returns deny when daemon denies', async () => {
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'denied', message: 'User denied' }),
          close: async () => {}
        })
      });

      const output = await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.strictEqual(output.hookSpecificOutput.decision.behavior, 'deny');
      assert.ok(output.hookSpecificOutput.decision.message.includes('denied'));
    });

    it('passes through on timeout_retry', async () => {
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => ({
            status: 'timeout_retry',
            message: 'User AFK. Current time: 10:00 UTC. Do not retry until after 10:05 UTC.'
          }),
          close: async () => {}
        })
      });

      const output = await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      // Passthrough on timeout - let user handle locally
      assert.strictEqual(output, null);
    });

    it('passes through on timeout_final', async () => {
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => ({
            status: 'timeout_final',
            message: 'User unavailable after multiple retries.'
          }),
          close: async () => {}
        })
      });

      const output = await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      // Passthrough on timeout - let user handle locally
      assert.strictEqual(output, null);
    });

    it('passes through on daemon connection error', async () => {
      const handler = createPermissionHandler({
        createClient: async () => {
          throw new Error('Connection refused');
        },
        logError: () => {} // Suppress logging in test
      });

      const output = await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.strictEqual(output, null); // passthrough on error
    });

    it('passes through on not_configured status', async () => {
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'not_configured', message: 'Telegram not configured' }),
          close: async () => {}
        })
      });

      const output = await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.strictEqual(output, null); // passthrough when not configured
    });

    it('includes request_id in message to daemon', async () => {
      let capturedMessage;
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            capturedMessage = msg;
            return { status: 'approved' };
          },
          close: async () => {}
        })
      });

      await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.ok(capturedMessage.request_id, 'Should include request_id');
      assert.ok(typeof capturedMessage.request_id === 'string');
    });

    it('includes terminal_id in message to daemon', async () => {
      let capturedMessage;
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            capturedMessage = msg;
            return { status: 'approved' };
          },
          close: async () => {}
        })
      });

      await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.ok(capturedMessage.terminal_id, 'Should include terminal_id');
      assert.ok(typeof capturedMessage.terminal_id === 'string');
    });

    it('closes client connection after handling', async () => {
      let closeCalled = false;
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'approved' }),
          close: async () => { closeCalled = true; }
        })
      });

      await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.ok(closeCalled, 'Client close should be called');
    });

    it('passes through on sendAndWait error', async () => {
      const handler = createPermissionHandler({
        createClient: async () => ({
          sendAndWait: async () => { throw new Error('Timeout'); },
          close: async () => {}
        }),
        logError: () => {}
      });

      const output = await handler.handle({ session_id: 'abc', tool_name: 'Bash' });

      assert.strictEqual(output, null); // passthrough on error
    });
  });

  describe('formatApproveOutput', () => {
    it('formats approval correctly', () => {
      const output = formatApproveOutput();

      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PermissionRequest');
      assert.strictEqual(output.hookSpecificOutput.decision.behavior, 'allow');
    });
  });

  describe('formatDenyOutput', () => {
    it('formats deny with message', () => {
      const output = formatDenyOutput('User denied the request');

      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PermissionRequest');
      assert.strictEqual(output.hookSpecificOutput.decision.behavior, 'deny');
      assert.strictEqual(output.hookSpecificOutput.decision.message, 'User denied the request');
    });
  });
});
