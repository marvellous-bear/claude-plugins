// Telegram client tests - TDD approach
// Tests for Telegram API client

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createTelegramClient } = require('./telegram.js');

describe('telegram client', () => {
  it('sends message and returns message_id', async () => {
    const mockFetch = async (url, options) => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 456 } })
    });

    const client = createTelegramClient('BOT_TOKEN', { fetch: mockFetch });
    const result = await client.sendMessage(123, 'Hello');

    assert.strictEqual(result.message_id, 456);
  });

  it('sends message with correct URL and body', async () => {
    let capturedUrl, capturedOptions;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } })
      };
    };

    const client = createTelegramClient('MY_TOKEN', { fetch: mockFetch });
    await client.sendMessage(12345, 'Test message');

    assert.ok(capturedUrl.includes('MY_TOKEN'));
    assert.ok(capturedUrl.includes('sendMessage'));

    const body = JSON.parse(capturedOptions.body);
    assert.strictEqual(body.chat_id, 12345);
    assert.strictEqual(body.text, 'Test message');
  });

  it('polls getUpdates with offset', async () => {
    const updates = [
      { update_id: 1, message: { text: 'yes', date: Date.now() / 1000 } },
      { update_id: 2, message: { text: 'no', date: Date.now() / 1000 } }
    ];

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, result: updates })
    });

    const client = createTelegramClient('TOKEN', { fetch: mockFetch });
    const result = await client.getUpdates(0);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].message.text, 'yes');
  });

  it('passes offset to getUpdates', async () => {
    let capturedUrl;

    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ ok: true, result: [] })
      };
    };

    const client = createTelegramClient('TOKEN', { fetch: mockFetch });
    await client.getUpdates(100);

    assert.ok(capturedUrl.includes('offset=100'));
  });

  it('uses long polling timeout', async () => {
    let capturedUrl;

    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ ok: true, result: [] })
      };
    };

    const client = createTelegramClient('TOKEN', { fetch: mockFetch });
    await client.getUpdates(0);

    assert.ok(capturedUrl.includes('timeout='));
  });

  it('retries on network failure with backoff', async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      if (attempts < 3) throw new Error('Network error');
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    };

    const client = createTelegramClient('TOKEN', {
      fetch: mockFetch,
      retryDelay: 10  // Fast for tests
    });
    await client.getUpdates(0);

    assert.strictEqual(attempts, 3);
  });

  it('throws after max retries exceeded', async () => {
    let attempts = 0;
    const mockFetch = async () => {
      attempts++;
      throw new Error('Network error');
    };

    const client = createTelegramClient('TOKEN', {
      fetch: mockFetch,
      maxRetries: 2,
      retryDelay: 10
    });

    await assert.rejects(
      client.getUpdates(0),
      /Network error/
    );

    assert.strictEqual(attempts, 3); // Initial + 2 retries
  });

  it('handles Telegram API error response', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found'
      })
    });

    const client = createTelegramClient('TOKEN', { fetch: mockFetch });

    await assert.rejects(
      client.sendMessage(12345, 'test'),
      /chat not found/
    );
  });

  it('filters stale updates', async () => {
    const now = Date.now() / 1000;
    const updates = [
      { update_id: 1, message: { text: 'old', date: now - 400 } },  // 400 seconds ago
      { update_id: 2, message: { text: 'recent', date: now - 60 } } // 60 seconds ago
    ];

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, result: updates })
    });

    const client = createTelegramClient('TOKEN', {
      fetch: mockFetch,
      staleThreshold: 300  // 5 minutes
    });

    const result = await client.getUpdates(0);

    // Should only return the recent message
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].message.text, 'recent');
  });

  it('returns empty array when not configured', async () => {
    const client = createTelegramClient(null);

    const result = await client.getUpdates(0);
    assert.deepStrictEqual(result, []);
  });

  it('isConfigured returns false without token', () => {
    const client = createTelegramClient(null);
    assert.strictEqual(client.isConfigured(), false);
  });

  it('isConfigured returns true with token', () => {
    const client = createTelegramClient('BOT_TOKEN');
    assert.strictEqual(client.isConfigured(), true);
  });

  it('sendMessage throws when not configured', async () => {
    const client = createTelegramClient(null);

    await assert.rejects(
      client.sendMessage(123, 'test'),
      /not configured/i
    );
  });
});
