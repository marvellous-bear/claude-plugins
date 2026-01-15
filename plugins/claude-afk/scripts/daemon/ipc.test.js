// IPC communication tests - TDD approach
// Tests for named pipe server and client

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createIPCServer, createIPCClient, getDefaultPipePath, DEFAULT_TIMEOUT } = require('./ipc.js');

describe('IPC communication', () => {
  let tempDir;
  let pipePath;
  let server;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
    // Use a unique pipe path for each test
    pipePath = path.join(tempDir, `test-${Date.now()}.sock`);
  });

  afterEach(async () => {
    // Clean up server if running
    if (server) {
      try {
        await server.stop();
      } catch (e) {
        // Ignore
      }
      server = null;
    }

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('server starts and stops cleanly', async () => {
    server = createIPCServer(pipePath);
    server.onMessage(() => {});

    await server.start();
    assert.strictEqual(server.isRunning(), true);

    await server.stop();
    assert.strictEqual(server.isRunning(), false);
  });

  it('server receives and parses NDJSON messages', async () => {
    server = createIPCServer(pipePath);
    const received = [];

    server.onMessage((msg, respond) => {
      received.push(msg);
      respond({ status: 'ok' });
    });

    await server.start();

    // Connect and send
    const client = await createIPCClient(pipePath);
    await client.send({ type: 'test', data: 'hello' });

    // Wait briefly for message processing
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, 'test');
    assert.strictEqual(received[0].data, 'hello');

    await client.close();
  });

  it('client receives response from server', async () => {
    server = createIPCServer(pipePath);
    server.onMessage((msg, respond) => {
      respond({ status: 'approved', request_id: msg.request_id });
    });

    await server.start();

    const client = await createIPCClient(pipePath);
    const response = await client.sendAndWait({
      type: 'permission_request',
      request_id: 'test-123'
    });

    assert.strictEqual(response.status, 'approved');
    assert.strictEqual(response.request_id, 'test-123');

    await client.close();
  });

  it('handles multiple concurrent clients', async () => {
    server = createIPCServer(pipePath);
    const responses = [];

    server.onMessage((msg, respond) => {
      // Echo back with client identifier
      respond({ status: 'ok', client: msg.client, request_id: msg.request_id });
    });

    await server.start();

    // Create multiple clients
    const client1 = await createIPCClient(pipePath);
    const client2 = await createIPCClient(pipePath);

    // Send from both
    const [resp1, resp2] = await Promise.all([
      client1.sendAndWait({ type: 'test', client: 'A', request_id: 'req-1' }),
      client2.sendAndWait({ type: 'test', client: 'B', request_id: 'req-2' })
    ]);

    assert.strictEqual(resp1.client, 'A');
    assert.strictEqual(resp2.client, 'B');

    await client1.close();
    await client2.close();
  });

  it('client times out waiting for response', async () => {
    server = createIPCServer(pipePath);
    server.onMessage((msg, respond) => {
      // Never respond
    });

    await server.start();

    const client = await createIPCClient(pipePath, { timeout: 100 });

    await assert.rejects(
      client.sendAndWait({ type: 'test', request_id: 'req-timeout' }),
      /timeout/i
    );

    await client.close();
  });

  it('handles connection refused gracefully', async () => {
    // No server running
    await assert.rejects(
      createIPCClient(pipePath),
      /ENOENT|ECONNREFUSED|connect/i
    );
  });

  it('correlates responses by request_id', async () => {
    server = createIPCServer(pipePath);

    // Respond to requests in reverse order after delay
    const pending = [];
    server.onMessage((msg, respond) => {
      pending.push({ msg, respond });
      if (pending.length === 2) {
        // Respond in reverse order
        setTimeout(() => {
          pending[1].respond({ status: 'second', request_id: pending[1].msg.request_id });
          pending[0].respond({ status: 'first', request_id: pending[0].msg.request_id });
        }, 20);
      }
    });

    await server.start();

    const client = await createIPCClient(pipePath);

    // Send two requests
    const [resp1, resp2] = await Promise.all([
      client.sendAndWait({ type: 'test', request_id: 'req-1' }),
      client.sendAndWait({ type: 'test', request_id: 'req-2' })
    ]);

    // Despite reverse order response, should correlate correctly
    assert.strictEqual(resp1.request_id, 'req-1');
    assert.strictEqual(resp2.request_id, 'req-2');

    await client.close();
  });

  it('getDefaultPipePath returns platform-appropriate path', () => {
    const pipePath = getDefaultPipePath();

    if (process.platform === 'win32') {
      // Returns Unix-style path for xpipe to convert
      assert.strictEqual(pipePath, '/claude-afk');
    } else {
      assert.strictEqual(pipePath, '/tmp/claude-afk.sock');
    }
  });

  it('DEFAULT_TIMEOUT matches hooks.json timeout (1 hour)', () => {
    // hooks.json specifies timeout: 3600 (seconds) for PermissionRequest and Stop hooks
    // The IPC client DEFAULT_TIMEOUT must match this to avoid premature timeouts
    // See: hooks/hooks.json lines 20 and 30
    const HOOKS_TIMEOUT_SECONDS = 3600;
    const EXPECTED_TIMEOUT_MS = HOOKS_TIMEOUT_SECONDS * 1000; // 3600000ms = 1 hour

    assert.strictEqual(
      DEFAULT_TIMEOUT,
      EXPECTED_TIMEOUT_MS,
      `DEFAULT_TIMEOUT (${DEFAULT_TIMEOUT}ms) should match hooks.json timeout (${EXPECTED_TIMEOUT_MS}ms / ${HOOKS_TIMEOUT_SECONDS}s)`
    );
  });
});
