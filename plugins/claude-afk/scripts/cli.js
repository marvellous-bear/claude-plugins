#!/usr/bin/env node
// Claude AFK CLI
// Unified command-line interface for enable/disable/status/setup
//
// PRD Reference (lines 557-561):
// - /claude-afk:enable - Activate AFK mode for current session
// - /claude-afk:disable - Deactivate AFK mode
// - /claude-afk:status - Show daemon status, active sessions, config
// - /claude-afk:setup - Initial setup wizard

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const { getSessionId, hasReliableTerminalId, getClaudeAfkDir } = require('./session-lookup');
const { createIPCClient, getDefaultPipePath } = require('./daemon/ipc');
const { getBotToken } = require('./daemon/telegram');
const { isLocked, getDefaultLockPath } = require('./daemon/singleton');

/**
 * Format status output for display
 */
function formatStatusOutput(status, currentSessionId) {
  if (!status.daemon_running) {
    return 'Claude AFK daemon is not running.\nRun /claude-afk:setup to configure.';
  }

  let output = 'Claude AFK Status\n';
  output += '=================\n\n';
  output += `Daemon: running\n`;
  output += `Telegram: ${status.telegram_configured ? 'configured' : 'not configured'}\n`;
  output += `Chat ID: ${status.chat_id_configured ? 'paired' : 'not paired'}\n`;
  output += `Always Enabled: ${status.always_enabled ? 'yes' : 'no'}\n\n`;

  output += `Active AFK Sessions: ${status.afk_sessions?.length || 0}\n`;
  if (status.afk_sessions?.length > 0) {
    status.afk_sessions.forEach(s => {
      const marker = s === currentSessionId ? ' (this session)' : '';
      output += `  - ${s.substring(0, 8)}...${marker}\n`;
    });
  }

  output += `\nPending Requests: ${status.pending_requests || 0}\n`;

  if (currentSessionId) {
    const isEnabled = status.afk_sessions?.includes(currentSessionId);
    output += `\nThis Session: ${isEnabled ? 'AFK mode enabled' : 'AFK mode disabled'}\n`;
  }

  return output;
}

/**
 * Format enable success output
 */
function formatEnableOutput(sessionId, unreliable) {
  let output = `AFK mode enabled for session ${sessionId.substring(0, 8)}...\n\n`;

  output += `You will receive Telegram notifications when:\n`;
  output += `  - Claude needs permission approvals for tool usage\n`;
  output += `  - Tasks are completed\n\n`;

  output += `Reply "yes" or "no" directly to Telegram messages to respond.\n\n`;

  output += `To disable AFK mode later, use /claude-afk:disable.\n\n`;

  // Instruction for Claude about question format
  output += `[For Claude: Avoid using AskUserQuestion tool while AFK - ask questions in narrative form instead.]\n`;

  if (unreliable) {
    output += '\nWarning: Using unreliable terminal ID (PID-based fallback).\n';
    output += 'Consider using Windows Terminal, iTerm2, or a terminal with session IDs.\n';
  }

  return output;
}

/**
 * Format disable success output
 */
function formatDisableOutput(sessionId) {
  return `AFK mode disabled for session ${sessionId.substring(0, 8)}...\n` +
         'Permission requests will be handled locally.\n';
}

/**
 * Format setup output
 */
function formatSetupOutput(state) {
  if (state.configured) {
    return 'Claude AFK is fully configured and ready!\n\n' +
           'Run /claude-afk:enable to activate AFK mode for this session.\n';
  }

  if (!state.hasToken) {
    return 'Claude AFK Setup\n' +
           '================\n\n' +
           'Step 1: Create a Telegram Bot\n' +
           '  1. Open Telegram and search for @BotFather\n' +
           '  2. Send /newbot and follow the prompts\n' +
           '  3. Copy the bot token (looks like: 123456:ABC-DEF...)\n\n' +
           'Step 2: Configure the Token\n' +
           '  Add to your environment:\n' +
           '    export CLAUDE_AFK_TELEGRAM_TOKEN="your-bot-token"\n' +
           '  Or add to ~/.env or your shell profile.\n\n' +
           'Step 3: Run /claude-afk:setup again after setting the token.\n';
  }

  if (state.waitingForPairing) {
    return 'Waiting for Telegram pairing...\n' +
           'Send /start to your Telegram bot now.\n';
  }

  if (state.needsPairing) {
    return 'Claude AFK Setup\n' +
           '================\n\n' +
           'Bot token is configured!\n\n' +
           'Final Step: Pair with Telegram\n' +
           '  1. Open your Telegram bot (find it by the username you created)\n' +
           '  2. Send /start to the bot\n' +
           '  3. Run /claude-afk:setup again to verify\n\n' +
           'The daemon will capture your chat ID automatically.\n';
  }

  return 'Claude AFK setup status unknown. Try running /claude-afk:status.\n';
}

/**
 * Check if daemon is running by trying to connect via IPC
 */
async function isDaemonRunning(clientFactory) {
  try {
    const client = await clientFactory();
    await client.close();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Start the daemon process
 * @returns {Promise<{started: boolean, error?: string}>}
 */
async function startDaemon() {
  const daemonPath = path.join(__dirname, 'daemon', 'index.js');

  return new Promise((resolve) => {
    const daemon = spawn('node', [daemonPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    daemon.unref();

    // Give it a moment to start
    setTimeout(() => {
      resolve({ started: true });
    }, 1000);

    daemon.on('error', (err) => {
      resolve({ started: false, error: err.message });
    });
  });
}

/**
 * Wait for daemon to be ready (IPC connectable)
 * @param {Function} clientFactory - Factory to create IPC client
 * @param {Object} options - Options
 * @param {number} options.timeoutMs - Max time to wait (default 10 seconds)
 * @param {number} options.intervalMs - Polling interval (default 500ms)
 * @returns {Promise<{ready: boolean, timedOut: boolean}>}
 */
async function waitForDaemon(clientFactory, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const intervalMs = options.intervalMs || 500;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const client = await clientFactory();
      await client.close();
      return { ready: true, timedOut: false };
    } catch (err) {
      // Daemon not ready yet, keep trying
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return { ready: false, timedOut: true };
}

/**
 * Poll for daemon status until chat_id is configured or timeout
 * @param {Function} clientFactory - Factory to create IPC client
 * @param {Object} options - Options
 * @param {number} options.timeoutMs - Max time to wait (default 60 seconds)
 * @param {number} options.intervalMs - Polling interval (default 2 seconds)
 * @param {Function} options.onProgress - Callback for progress updates
 * @returns {Promise<{paired: boolean, timedOut: boolean}>}
 */
async function waitForPairing(clientFactory, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const intervalMs = options.intervalMs || 2000;
  const onProgress = options.onProgress || (() => {});
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const client = await clientFactory();
      try {
        const response = await client.sendAndWait({
          type: 'status',
          request_id: crypto.randomUUID()
        });

        if (response.chat_id_configured) {
          return { paired: true, timedOut: false };
        }

        // Report progress
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const remaining = Math.round((timeoutMs - (Date.now() - startTime)) / 1000);
        onProgress({ elapsed, remaining });
      } finally {
        await client.close();
      }
    } catch (err) {
      // Daemon might not be ready yet, keep trying
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return { paired: false, timedOut: true };
}

/**
 * Create CLI with injected dependencies (for testing)
 */
function createCLI(options = {}) {
  const getSession = options.getSessionId || getSessionId;
  const checkReliable = options.hasReliableTerminalId || hasReliableTerminalId;
  const clientFactory = options.createClient || (() => createIPCClient(getDefaultPipePath()));
  const tokenFn = options.getBotToken || getBotToken;

  return {
    async run(args) {
      const command = args[0];

      switch (command) {
        case 'enable':
          return this.enable();
        case 'disable':
          return this.disable();
        case 'status':
          return this.status();
        case 'setup':
          return this.setup();
        default:
          return {
            success: false,
            message: command
              ? `Unknown command: ${command}\n\nUsage: cli.js <enable|disable|status|setup>`
              : 'Usage: cli.js <enable|disable|status|setup>\n\n' +
                'Commands:\n' +
                '  enable   - Enable AFK mode for current session\n' +
                '  disable  - Disable AFK mode for current session\n' +
                '  status   - Show daemon and session status\n' +
                '  setup    - Configure Telegram bot integration\n'
          };
      }
    },

    async enable() {
      const sessionId = getSession();
      if (!sessionId) {
        return {
          success: false,
          message: 'No Claude Code session found for this terminal.\n' +
                   'Make sure you are running this from within a Claude Code session.'
        };
      }

      const unreliable = !checkReliable();

      // Check if daemon is running, start it if not
      const daemonRunning = await isDaemonRunning(clientFactory);
      if (!daemonRunning) {
        // Check if we have a token first
        if (!tokenFn()) {
          return {
            success: false,
            message: 'Telegram bot token not configured.\n' +
                     'Run /claude-afk:setup to configure your Telegram bot.'
          };
        }

        // Start the daemon
        const startResult = await startDaemon();
        if (!startResult.started) {
          return {
            success: false,
            message: `Failed to start daemon: ${startResult.error || 'Unknown error'}`
          };
        }

        // Wait for daemon to be ready (poll with retries)
        const daemonReady = await waitForDaemon(clientFactory);
        if (!daemonReady.ready) {
          return {
            success: false,
            message: 'Daemon started but failed to become ready.\n' +
                     'Check logs at ~/.claude/claude-afk/logs/ for errors.'
          };
        }
      }

      try {
        const client = await clientFactory();
        try {
          const response = await client.sendAndWait({
            type: 'enable_afk',
            request_id: crypto.randomUUID(),
            session_id: sessionId
          });

          if (response.status === 'enabled') {
            return {
              success: true,
              message: formatEnableOutput(sessionId, unreliable),
              warning: unreliable ? 'Unreliable terminal ID' : undefined
            };
          }

          return {
            success: false,
            message: `Failed to enable AFK mode: ${response.message || response.status}`
          };
        } finally {
          await client.close();
        }
      } catch (err) {
        return {
          success: false,
          message: `Cannot connect to daemon: ${err.message}\n` +
                   'Run /claude-afk:setup to configure and start the daemon.'
        };
      }
    },

    async disable() {
      const sessionId = getSession();
      if (!sessionId) {
        return {
          success: false,
          message: 'No Claude Code session found for this terminal.'
        };
      }

      try {
        const client = await clientFactory();
        try {
          const response = await client.sendAndWait({
            type: 'disable_afk',
            request_id: crypto.randomUUID(),
            session_id: sessionId
          });

          if (response.status === 'disabled') {
            return {
              success: true,
              message: formatDisableOutput(sessionId)
            };
          }

          return {
            success: false,
            message: `Failed to disable AFK mode: ${response.message || response.status}`
          };
        } finally {
          await client.close();
        }
      } catch (err) {
        return {
          success: false,
          message: `Cannot connect to daemon: ${err.message}`
        };
      }
    },

    async status() {
      const sessionId = getSession();

      try {
        const client = await clientFactory();
        try {
          const response = await client.sendAndWait({
            type: 'status',
            request_id: crypto.randomUUID()
          });

          return {
            success: true,
            status: response,
            message: formatStatusOutput(response, sessionId)
          };
        } finally {
          await client.close();
        }
      } catch (err) {
        // Daemon not running - that's a valid status
        return {
          success: true,
          status: { daemon_running: false },
          message: formatStatusOutput({ daemon_running: false }, sessionId)
        };
      }
    },

    async setup(options = {}) {
      const hasToken = !!tokenFn();
      const wait = options.wait !== false; // Default to waiting

      // Step 1: Check token
      if (!hasToken) {
        return {
          success: true,
          configured: false,
          instructions: formatSetupOutput({ configured: false, hasToken: false })
        };
      }

      // Step 2: Ensure daemon is running
      const daemonRunning = await isDaemonRunning(clientFactory);

      if (!daemonRunning) {
        // Start the daemon
        const startResult = await startDaemon();
        if (!startResult.started) {
          return {
            success: false,
            message: `Failed to start daemon: ${startResult.error || 'Unknown error'}`
          };
        }

        // Wait a bit for daemon to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Step 3: Check if already paired
      try {
        const client = await clientFactory();
        try {
          const response = await client.sendAndWait({
            type: 'status',
            request_id: crypto.randomUUID()
          });

          if (response.telegram_configured && response.chat_id_configured) {
            return {
              success: true,
              configured: true,
              instructions: formatSetupOutput({ configured: true })
            };
          }

          // Not paired yet - wait for pairing if requested
          if (wait) {
            // Print immediate feedback so user knows what's happening
            console.log('Waiting for Telegram pairing...');
            console.log('Send /start to your Telegram bot now.\n');

            // Poll for pairing completion with progress updates
            let lastDot = 0;
            const pairingResult = await waitForPairing(clientFactory, {
              timeoutMs: 60000,
              onProgress: ({ remaining }) => {
                // Print a dot every 10 seconds to show we're still waiting
                const dotCount = Math.floor((60 - remaining) / 10);
                while (lastDot < dotCount) {
                  process.stdout.write('.');
                  lastDot++;
                }
              }
            });

            // Newline after dots
            if (lastDot > 0) console.log('');

            if (pairingResult.paired) {
              return {
                success: true,
                configured: true,
                instructions: 'Telegram paired successfully!\n\n' +
                             'Claude AFK is fully configured and ready.\n' +
                             'Run /claude-afk:enable to activate AFK mode for this session.\n'
              };
            }

            // Timed out
            return {
              success: true,
              configured: false,
              instructions: 'Pairing timed out after 60 seconds.\n\n' +
                           'Make sure you:\n' +
                           '  1. Found your Telegram bot (search by the username you created)\n' +
                           '  2. Sent /start to the bot\n\n' +
                           'Run /claude-afk:setup to try again.\n'
            };
          }

          // Not waiting - just show instructions
          return {
            success: true,
            configured: false,
            instructions: formatSetupOutput({
              configured: false,
              hasToken: true,
              needsPairing: true
            })
          };
        } finally {
          await client.close();
        }
      } catch (err) {
        return {
          success: false,
          message: `Cannot connect to daemon: ${err.message}\n` +
                   'The daemon may have failed to start. Check logs.'
        };
      }
    }
  };
}

// Run if executed directly
if (require.main === module) {
  const cli = createCLI();
  const args = process.argv.slice(2);

  cli.run(args)
    .then(result => {
      if (result.message) {
        console.log(result.message);
      }
      if (result.instructions) {
        console.log(result.instructions);
      }
      process.exit(result.success ? 0 : 1);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = {
  createCLI,
  formatStatusOutput,
  formatEnableOutput,
  formatDisableOutput,
  formatSetupOutput,
  isDaemonRunning,
  startDaemon,
  waitForDaemon,
  waitForPairing
};
