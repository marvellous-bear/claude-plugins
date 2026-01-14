#!/usr/bin/env node
// Stop hook handler
// Sends stop requests to daemon, waits for follow-up instructions from Telegram
//
// PRD Reference (lines 894-913):
// - Connect to daemon via named pipe
// - Send stop_request with session_id, transcript_path
// - Wait for response: continue (with instructions), stop, not_enabled
// - Fail-open on any error (passthrough)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createIPCClient, getDefaultPipePath } = require('./daemon/ipc');
const { getClaudeAfkDir, getTerminalId } = require('./session-lookup');

/**
 * Format hook output for continue with instructions
 * Injects the instructions as Claude's next user prompt
 *
 * @param {string} instructions - Follow-up instructions from user
 * @returns {Object} Claude hook output format
 */
function formatContinueOutput(instructions) {
  // Use decision: "block" with reason field to inject the prompt
  // The reason becomes Claude's next input (like user typed it)
  // See: https://github.com/anthropics/claude-code - ralph-wiggum example
  return {
    decision: 'block',
    reason: instructions
  };
}

/**
 * Format hook output for stop (no continuation)
 * @returns {Object} Claude hook output format
 */
function formatStopOutput() {
  // Return empty object to allow stop to proceed normally
  return {};
}

/**
 * Create a stop handler with injected dependencies (for testing)
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.createClient - Function to create IPC client
 * @param {string} options.pipePath - Path to daemon named pipe
 * @param {Function} options.logError - Function to log errors
 * @returns {Object} Handler with handle method
 */
function createStopHandler(options = {}) {
  const createClient = options.createClient || (() => createIPCClient(options.pipePath || getDefaultPipePath()));
  const logError = options.logError || defaultLogError;

  return {
    /**
     * Handle Stop hook input
     *
     * @param {Object} input - Parsed hook input
     * @param {string} input.session_id - Claude session ID
     * @param {string} input.transcript_path - Path to transcript file
     * @param {string} input.cwd - Current working directory
     * @returns {Object|null} Hook output or null for passthrough
     */
    async handle(input) {
      let client = null;

      try {
        const { session_id, transcript_path, cwd } = input;

        // Connect to daemon
        client = await createClient();

        // Send stop request
        const response = await client.sendAndWait({
          type: 'stop_request',
          request_id: crypto.randomUUID(),
          session_id,
          terminal_id: getTerminalId().id,
          transcript_path,
          cwd
        });

        // Handle response
        switch (response.status) {
          case 'continue':
            return formatContinueOutput(response.instructions || '');

          case 'stop':
            return formatStopOutput();

          case 'not_enabled':
          case 'not_configured':
            // Passthrough - AFK not enabled or not configured
            return null;

          case 'error':
            logError(new Error(response.message || 'Daemon error'));
            return null; // Passthrough on daemon error

          default:
            logError(new Error(`Unknown response status: ${response.status}`));
            return null; // Passthrough on unknown status
        }
      } catch (err) {
        logError(err);
        return null; // Fail-open: passthrough on any error
      } finally {
        if (client) {
          try {
            await client.close();
          } catch (e) {
            // Ignore close errors
          }
        }
      }
    }
  };
}

/**
 * Default error logging function
 */
function defaultLogError(err) {
  const logDir = path.join(getClaudeAfkDir(), 'logs');
  const logFile = path.join(logDir, 'hook.log');

  try {
    fs.mkdirSync(logDir, { recursive: true });
    const entry = `${new Date().toISOString()} [stop-handler] ERROR: ${err.message}\n`;
    fs.appendFileSync(logFile, entry);
  } catch (e) {
    // Can't even log - give up silently
  }
}

/**
 * Read all stdin and parse as JSON
 * @returns {Promise<Object>} Parsed input
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(input));
      } catch (err) {
        reject(new Error(`Failed to parse stdin: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Capture payload for debugging (when CLAUDE_AFK_DEBUG=1)
 */
function maybeCapturePayload(input) {
  if (process.env.CLAUDE_AFK_DEBUG !== '1') return;

  try {
    const { capturePayload, captureTranscript } = require('./payload-capture');

    // Capture the hook input payload
    capturePayload('stop', input);

    // Also capture transcript snapshot if available
    if (input.transcript_path) {
      captureTranscript(input.transcript_path, 'stop_before');
    }
  } catch (e) {
    // Ignore capture errors - don't affect normal operation
  }
}

/**
 * Log timing information for debugging
 */
function logTiming(startTime, event, details = '') {
  const elapsed = Date.now() - startTime;
  const logDir = path.join(getClaudeAfkDir(), 'logs');
  const logFile = path.join(logDir, 'hook-timing.log');

  try {
    fs.mkdirSync(logDir, { recursive: true });
    const entry = `${new Date().toISOString()} [stop-handler] ${event} (${elapsed}ms) ${details}\n`;
    fs.appendFileSync(logFile, entry);
  } catch (e) {
    // Ignore
  }
}

// Run if executed directly
if (require.main === module) {
  const startTime = Date.now();
  logTiming(startTime, 'START', `pid=${process.pid}`);

  // Log on any exit
  process.on('exit', (code) => {
    logTiming(startTime, 'EXIT', `code=${code}`);
  });

  // Log on signals
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
    process.on(signal, () => {
      logTiming(startTime, `SIGNAL:${signal}`);
    });
  });

  const handler = createStopHandler();

  readStdin()
    .then(input => {
      logTiming(startTime, 'STDIN_RECEIVED', `session=${input.session_id?.substring(0, 8)}`);
      maybeCapturePayload(input);
      return handler.handle(input);
    })
    .then(output => {
      logTiming(startTime, 'RESPONSE_RECEIVED', output ? `keys=${Object.keys(output).join(',')}` : 'passthrough');
      if (output) {
        // Output decision to stdout
        console.log(JSON.stringify(output));
      }
      process.exit(0);
    })
    .catch(err => {
      logTiming(startTime, 'ERROR', err.message);
      defaultLogError(err);
      process.exit(0); // Fail-open
    });
}

module.exports = {
  createStopHandler,
  formatContinueOutput,
  formatStopOutput
};
