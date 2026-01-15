// CLI tests - TDD approach
// Tests for unified CLI with enable/disable/status/setup subcommands

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createCLI,
  formatStatusOutput,
  formatEnableOutput,
  formatDisableOutput,
  formatSetupOutput
} = require('./cli.js');

describe('CLI', () => {
  describe('enable command', () => {
    it('enables AFK mode for current session', async () => {
      const sentMessages = [];
      const cli = createCLI({
        getSessionId: () => 'sess-abc-123',
        hasReliableTerminalId: () => true,
        createClient: async () => ({
          sendAndWait: async (msg) => {
            sentMessages.push(msg);
            return { status: 'enabled' };
          },
          close: async () => {}
        })
      });

      const result = await cli.run(['enable']);

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].type, 'enable_afk');
      assert.strictEqual(sentMessages[0].session_id, 'sess-abc-123');
      assert.ok(sentMessages[0].request_id, 'Should include request_id');
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('enabled'));
    });

    it('fails when no session found', async () => {
      const cli = createCLI({
        getSessionId: () => null,
        hasReliableTerminalId: () => true,
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'enabled' }),
          close: async () => {}
        })
      });

      const result = await cli.run(['enable']);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('session'));
    });

    it('warns when terminal ID is unreliable', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => false,
        createClient: async () => ({
          sendAndWait: async () => ({ status: 'enabled' }),
          close: async () => {}
        })
      });

      const result = await cli.run(['enable']);

      assert.strictEqual(result.success, true);
      assert.ok(result.warning, 'Should include warning about unreliable terminal ID');
    });

    it('fails when no token configured and daemon not running', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true,
        getBotToken: () => null, // No token configured
        createClient: async () => {
          throw new Error('Connection refused');
        }
      });

      const result = await cli.run(['enable']);

      assert.strictEqual(result.success, false);
      // Without token, should suggest running setup
      assert.ok(result.message.includes('setup') || result.message.includes('token'));
    });
  });

  describe('disable command', () => {
    it('disables AFK mode for current session', async () => {
      const sentMessages = [];
      const cli = createCLI({
        getSessionId: () => 'sess-abc-123',
        hasReliableTerminalId: () => true,
        createClient: async () => ({
          sendAndWait: async (msg) => {
            sentMessages.push(msg);
            return { status: 'disabled' };
          },
          close: async () => {}
        })
      });

      const result = await cli.run(['disable']);

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].type, 'disable_afk');
      assert.strictEqual(sentMessages[0].session_id, 'sess-abc-123');
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes('disabled'));
    });

    it('fails when no session found', async () => {
      const cli = createCLI({
        getSessionId: () => null,
        hasReliableTerminalId: () => true
      });

      const result = await cli.run(['disable']);

      assert.strictEqual(result.success, false);
    });
  });

  describe('status command', () => {
    it('returns daemon status', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true,
        createClient: async () => ({
          sendAndWait: async (msg) => {
            assert.strictEqual(msg.type, 'status');
            return {
              status: 'status_response',
              daemon_running: true,
              telegram_configured: true,
              chat_id_configured: true,
              afk_sessions: ['sess-123', 'sess-456'],
              pending_requests: 2,
              always_enabled: false
            };
          },
          close: async () => {}
        })
      });

      const result = await cli.run(['status']);

      assert.strictEqual(result.success, true);
      assert.ok(result.status.daemon_running);
      assert.ok(result.status.telegram_configured);
      assert.strictEqual(result.status.afk_sessions.length, 2);
    });

    it('shows not running when daemon unreachable', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true,
        createClient: async () => {
          throw new Error('Connection refused');
        }
      });

      const result = await cli.run(['status']);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status.daemon_running, false);
    });

    it('does not require session for status', async () => {
      const cli = createCLI({
        getSessionId: () => null, // No session
        hasReliableTerminalId: () => true,
        createClient: async () => ({
          sendAndWait: async () => ({
            status: 'status_response',
            daemon_running: true,
            afk_sessions: []
          }),
          close: async () => {}
        })
      });

      const result = await cli.run(['status']);

      assert.strictEqual(result.success, true);
    });
  });

  describe('setup command', () => {
    it('provides setup instructions when not configured', async () => {
      const cli = createCLI({
        getSessionId: () => null,
        hasReliableTerminalId: () => true,
        getBotToken: () => null, // Not configured
        createClient: async () => {
          throw new Error('Connection refused');
        }
      });

      const result = await cli.run(['setup']);

      assert.strictEqual(result.success, true);
      assert.ok(result.instructions, 'Should include setup instructions');
      assert.ok(result.instructions.includes('BotFather') || result.instructions.includes('token'));
    });

    it('shows configured status when token exists', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true,
        getBotToken: () => 'bot123:ABC',
        createClient: async () => ({
          sendAndWait: async () => ({
            status: 'status_response',
            daemon_running: true,
            telegram_configured: true,
            chat_id_configured: true,
            afk_sessions: []
          }),
          close: async () => {}
        })
      });

      const result = await cli.run(['setup']);

      assert.strictEqual(result.success, true);
      assert.ok(result.configured);
    });

    it('prompts to send /start when token exists but no chat_id', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true,
        getBotToken: () => 'bot123:ABC',
        createClient: async () => ({
          sendAndWait: async () => ({
            status: 'status_response',
            daemon_running: true,
            telegram_configured: true,
            chat_id_configured: false,
            afk_sessions: []
          }),
          close: async () => {}
        })
      });

      // Use wait: false to avoid 60-second timeout in CI
      const result = await cli.setup({ wait: false });

      assert.strictEqual(result.success, true);
      assert.ok(result.instructions.includes('/start'));
    });
  });

  describe('unknown command', () => {
    it('returns error for unknown command', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true
      });

      const result = await cli.run(['unknown']);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Unknown'));
    });

    it('shows help when no command provided', async () => {
      const cli = createCLI({
        getSessionId: () => 'sess-123',
        hasReliableTerminalId: () => true
      });

      const result = await cli.run([]);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Usage') || result.message.includes('enable'));
    });
  });

  describe('formatStatusOutput', () => {
    it('formats complete status', () => {
      const output = formatStatusOutput({
        daemon_running: true,
        telegram_configured: true,
        chat_id_configured: true,
        afk_sessions: ['sess-1', 'sess-2'],
        pending_requests: 3,
        always_enabled: false
      }, 'sess-1');

      assert.ok(output.includes('running'));
      assert.ok(output.includes('Telegram'));
      assert.ok(output.includes('2')); // sessions count
      assert.ok(output.includes('3')); // pending count
      assert.ok(output.includes('enabled') || output.includes('active')); // current session status
    });

    it('shows not running status', () => {
      const output = formatStatusOutput({
        daemon_running: false
      }, null);

      assert.ok(output.includes('not running') || output.includes('stopped'));
    });
  });

  describe('formatEnableOutput', () => {
    it('formats success message', () => {
      const output = formatEnableOutput('sess-abc', false);
      assert.ok(output.includes('enabled'));
      assert.ok(output.includes('sess-abc'));
    });

    it('includes warning when unreliable', () => {
      const output = formatEnableOutput('sess-abc', true);
      assert.ok(output.includes('enabled'));
      assert.ok(output.includes('warning') || output.includes('Warning') || output.includes('unreliable'));
    });
  });

  describe('formatDisableOutput', () => {
    it('formats success message', () => {
      const output = formatDisableOutput('sess-abc');
      assert.ok(output.includes('disabled'));
    });
  });

  describe('formatSetupOutput', () => {
    it('formats not configured instructions', () => {
      const output = formatSetupOutput({ configured: false, hasToken: false });
      assert.ok(output.includes('BotFather') || output.includes('@BotFather'));
      assert.ok(output.includes('CLAUDE_AFK_TELEGRAM_TOKEN'));
    });

    it('formats needs pairing instructions', () => {
      const output = formatSetupOutput({ configured: false, hasToken: true, needsPairing: true });
      assert.ok(output.includes('/start'));
    });

    it('formats fully configured status', () => {
      const output = formatSetupOutput({ configured: true });
      assert.ok(output.includes('ready') || output.includes('configured') || output.includes('complete'));
    });
  });
});
