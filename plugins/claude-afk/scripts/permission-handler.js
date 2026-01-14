#!/usr/bin/env node
// PermissionRequest hook handler
// Sends permission requests to daemon, waits for response from Telegram
//
// PRD Reference (lines 829-859):
// - Connect to daemon via named pipe
// - Send permission_request with session_id, tool_name, message
// - Wait for response: approved, denied, not_enabled, timeout_retry, timeout_final
// - Fail-open on any error (passthrough)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createIPCClient, getDefaultPipePath } = require('./daemon/ipc');
const { getClaudeAfkDir, getTerminalId } = require('./session-lookup');

/**
 * Format hook output for approval
 * @returns {Object} Claude hook output format
 */
function formatApproveOutput() {
  // Per https://code.claude.com/docs/en/hooks#response-schema
  // PermissionRequest uses hookSpecificOutput with behavior: "allow"
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  };
}

/**
 * Format hook output for denial
 * @param {string} message - Denial reason
 * @returns {Object} Claude hook output format
 */
function formatDenyOutput(message) {
  // Per https://code.claude.com/docs/en/hooks#response-schema
  // PermissionRequest uses hookSpecificOutput with behavior: "deny"
  // interrupt: true stops Claude from continuing
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: message,
        interrupt: true
      }
    }
  };
}

/**
 * Create a permission handler with injected dependencies (for testing)
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.createClient - Function to create IPC client
 * @param {string} options.pipePath - Path to daemon named pipe
 * @param {Function} options.logError - Function to log errors
 * @returns {Object} Handler with handle method
 */
function createPermissionHandler(options = {}) {
  const createClient = options.createClient || (() => createIPCClient(options.pipePath || getDefaultPipePath()));
  const logError = options.logError || defaultLogError;

  return {
    /**
     * Handle PermissionRequest hook input
     *
     * @param {Object} input - Parsed hook input
     * @param {string} input.session_id - Claude session ID
     * @param {string} input.tool_name - Tool requesting permission
     * @param {string} input.message - Permission message
     * @param {string} input.transcript_path - Path to transcript file
     * @param {string} input.cwd - Current working directory
     * @returns {Object|null} Hook output or null for passthrough
     */
    async handle(input) {
      let client = null;

      try {
        const { session_id, tool_name, message, transcript_path, cwd } = input;

        // Connect to daemon
        client = await createClient();

        // Send permission request
        const response = await client.sendAndWait({
          type: 'permission_request',
          request_id: crypto.randomUUID(),
          session_id,
          terminal_id: getTerminalId().id,
          tool_name,
          message,
          transcript_path,
          cwd
        });

        // Handle response
        switch (response.status) {
          case 'approved':
            return formatApproveOutput();

          case 'denied':
            return formatDenyOutput(response.message || 'User denied the request');

          case 'timeout_retry':
          case 'timeout_final':
            // On timeout, passthrough to Claude's normal permission prompt
            // rather than denying - let user handle it locally
            return null;

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
    const entry = `${new Date().toISOString()} [permission-handler] ERROR: ${err.message}\n`;
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
    capturePayload('permission', input);

    // Also capture transcript snapshot if available
    if (input.transcript_path) {
      captureTranscript(input.transcript_path, 'permission_before');
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
    const entry = `${new Date().toISOString()} [permission-handler] ${event} (${elapsed}ms) ${details}\n`;
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

  const handler = createPermissionHandler();

  readStdin()
    .then(input => {
      logTiming(startTime, 'STDIN_RECEIVED', `tool=${input.tool_name}`);
      maybeCapturePayload(input);
      return handler.handle(input);
    })
    .then(output => {
      logTiming(startTime, 'RESPONSE_RECEIVED', output ? `status=${JSON.stringify(output).substring(0, 100)}` : 'passthrough');
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
  createPermissionHandler,
  formatApproveOutput,
  formatDenyOutput
};
