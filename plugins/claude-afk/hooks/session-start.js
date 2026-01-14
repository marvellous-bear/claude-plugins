#!/usr/bin/env node
// SessionStart hook - registers terminal_id → session_id mapping
// Enables concurrent Claude Code sessions in different terminals
//
// PRD Reference (lines 599-613):
// - Register terminal_id → session_id mapping on session start
// - Write to ~/.claude/sessions/by-terminal/{terminal_id}.json
// - Always passthrough (exit 0)

const fs = require('fs');
const path = require('path');

const { getTerminalId, getSessionsDir, getClaudeAfkDir } = require('../scripts/session-lookup');

/**
 * Create a session-start handler with injected dependencies (for testing)
 *
 * @param {Object} options - Configuration options
 * @param {string} options.sessionsDir - Directory for session files
 * @param {Function} options.getTerminalId - Function to get terminal ID
 * @param {Function} options.logError - Function to log errors
 * @returns {Object} Handler with handle method
 */
function createSessionStartHandler(options = {}) {
  const sessionsDir = options.sessionsDir || getSessionsDir();
  const terminalIdFn = options.getTerminalId || getTerminalId;
  const logError = options.logError || defaultLogError;

  return {
    /**
     * Handle SessionStart hook input
     *
     * @param {Object} input - Parsed hook input
     * @param {string} input.session_id - Claude session ID
     * @param {string} input.transcript_path - Path to transcript file
     * @param {string} input.cwd - Current working directory
     * @returns {null} Always returns null (passthrough)
     */
    async handle(input) {
      try {
        const { session_id, transcript_path, cwd } = input;
        const terminalInfo = terminalIdFn();
        const terminalId = terminalInfo.id;

        // Ensure sessions directory exists
        fs.mkdirSync(sessionsDir, { recursive: true });

        // Write session mapping
        const sessionFile = path.join(sessionsDir, `${terminalId}.json`);
        const sessionData = {
          sessionId: session_id,
          transcriptPath: transcript_path,
          cwd: cwd,
          startedAt: new Date().toISOString(),
          terminalId: terminalId,
          terminalIdSource: terminalInfo.source
        };

        fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));

        return null; // Passthrough
      } catch (err) {
        logError(err);
        return null; // Fail-open: passthrough on error
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
    const entry = `${new Date().toISOString()} [session-start] ERROR: ${err.message}\n`;
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

// Run if executed directly
if (require.main === module) {
  const handler = createSessionStartHandler();

  readStdin()
    .then(input => handler.handle(input))
    .then(() => process.exit(0))
    .catch(err => {
      defaultLogError(err);
      process.exit(0); // Fail-open
    });
}

module.exports = {
  createSessionStartHandler
};
