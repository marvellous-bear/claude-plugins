// Stop handler tests - TDD approach
// Tests for Stop hook handler

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createStopHandler, formatContinueOutput, formatStopOutput } = require('./stop-handler.js');

describe('stop handler', () => {
  describe('handle', () => {
    it('passes through when daemon says not enabled', async () => {
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'not_enabled' }),
          close: async () => {}
        })
      });

      const input = { session_id: 'abc', transcript_path: '/path/to/transcript.jsonl', cwd: '/project' };
      const output = await handler.handle(input);

      assert.strictEqual(output, null); // null = passthrough
    });

    it('returns block with instructions when daemon says continue', async () => {
      const sentMessages = [];
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            sentMessages.push(msg);
            return { status: 'continue', instructions: 'Now run the tests' };
          },
          close: async () => {}
        })
      });

      const input = {
        session_id: 'abc',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/project'
      };
      const output = await handler.handle(input);

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].type, 'stop_request');
      assert.strictEqual(sentMessages[0].session_id, 'abc');
      assert.strictEqual(output.decision, 'block');
      assert.strictEqual(output.reason, 'Now run the tests');
    });

    it('returns empty object when daemon says stop', async () => {
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'stop' }),
          close: async () => {}
        })
      });

      const output = await handler.handle({ session_id: 'abc', transcript_path: '/t.jsonl', cwd: '/cwd' });

      assert.deepStrictEqual(output, {});
    });

    it('passes through on daemon connection error', async () => {
      const handler = createStopHandler({
        createClient: async () => {
          throw new Error('Connection refused');
        },
        logError: () => {} // Suppress logging in test
      });

      const output = await handler.handle({ session_id: 'abc' });

      assert.strictEqual(output, null); // passthrough on error
    });

    it('passes through on not_configured status', async () => {
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'not_configured', message: 'Telegram not configured' }),
          close: async () => {}
        })
      });

      const output = await handler.handle({ session_id: 'abc' });

      assert.strictEqual(output, null); // passthrough when not configured
    });

    it('includes request_id in message to daemon', async () => {
      let capturedMessage;
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            capturedMessage = msg;
            return { status: 'stop' };
          },
          close: async () => {}
        })
      });

      await handler.handle({ session_id: 'abc', transcript_path: '/t.jsonl', cwd: '/cwd' });

      assert.ok(capturedMessage.request_id, 'Should include request_id');
      assert.ok(typeof capturedMessage.request_id === 'string');
    });

    it('closes client connection after handling', async () => {
      let closeCalled = false;
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'stop' }),
          close: async () => { closeCalled = true; }
        })
      });

      await handler.handle({ session_id: 'abc' });

      assert.ok(closeCalled, 'Client close should be called');
    });

    it('passes through on sendAndWait error', async () => {
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async () => { throw new Error('Timeout'); },
          close: async () => {}
        }),
        logError: () => {}
      });

      const output = await handler.handle({ session_id: 'abc' });

      assert.strictEqual(output, null); // passthrough on error
    });

    it('includes transcript_path and cwd in request', async () => {
      let capturedMessage;
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            capturedMessage = msg;
            return { status: 'stop' };
          },
          close: async () => {}
        })
      });

      await handler.handle({
        session_id: 'abc',
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/my/project'
      });

      assert.strictEqual(capturedMessage.transcript_path, '/path/to/transcript.jsonl');
      assert.strictEqual(capturedMessage.cwd, '/my/project');
    });

    it('includes terminal_id in message to daemon', async () => {
      let capturedMessage;
      const handler = createStopHandler({
        createClient: async () => ({
          sendAndWait: async (msg) => {
            capturedMessage = msg;
            return { status: 'stop' };
          },
          close: async () => {}
        })
      });

      await handler.handle({ session_id: 'abc', transcript_path: '/t.jsonl', cwd: '/cwd' });

      assert.ok(capturedMessage.terminal_id, 'Should include terminal_id');
      assert.ok(typeof capturedMessage.terminal_id === 'string');
    });
  });

  describe('formatContinueOutput', () => {
    it('formats continue with instructions', () => {
      const output = formatContinueOutput('Run the tests now');

      assert.strictEqual(output.decision, 'block');
      assert.strictEqual(output.reason, 'Run the tests now');
    });

    it('handles empty instructions', () => {
      const output = formatContinueOutput('');

      assert.strictEqual(output.decision, 'block');
      assert.strictEqual(output.reason, '');
    });
  });

  describe('formatStopOutput', () => {
    it('formats stop correctly', () => {
      const output = formatStopOutput();

      assert.deepStrictEqual(output, {});
    });
  });
});
