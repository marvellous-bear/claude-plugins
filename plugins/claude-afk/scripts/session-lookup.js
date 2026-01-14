// Session lookup helper for claude-afk plugin
// Usage: const { getSessionId, getSessionInfo, getTerminalId } = require('./session-lookup');

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const claudeDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude');
const sessionsDir = path.join(claudeDir, 'sessions', 'by-terminal');

/**
 * Get controlling TTY on Linux/Unix (works even when stdio is piped)
 * @returns {string|null} TTY identifier or null
 */
function getControllingTty() {
  if (process.platform === 'win32') return null;

  try {
    // Method 1: Use ps command
    const tty = execSync('ps -o tty= -p $$', {
      encoding: 'utf8',
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (tty && tty !== '?' && tty !== '') {
      return tty.replace(/\//g, '-'); // pts/4 -> pts-4
    }
  } catch (e) {
    // Fallback: parse /proc/self/stat
    try {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const ttyNr = parseInt(stat.split(' ')[6]);

      if (ttyNr !== 0) {
        const major = ttyNr >> 8;
        const minor = ttyNr & 0xff;

        // pts devices have major 136-143
        if (major >= 136 && major <= 143) {
          const ptsNum = (major - 136) * 256 + minor;
          return `pts-${ptsNum}`;
        }
        // Regular tty
        if (major === 4) {
          return `tty${minor}`;
        }
      }
    } catch (e2) {
      // Ignore
    }
  }

  return null;
}

/**
 * Get terminal identifier with source information
 * Priority order matches PRD cross-platform terminal identification table
 * @returns {{id: string, source: string, reliable: boolean}}
 */
function getTerminalId() {
  // 1. Windows Terminal (Windows + WSL via WSLENV) - Excellent
  if (process.env.WT_SESSION) {
    return { id: process.env.WT_SESSION, source: 'WT_SESSION', reliable: true };
  }

  // 2. macOS Terminal.app and iTerm2 - Excellent
  if (process.env.TERM_SESSION_ID) {
    return { id: process.env.TERM_SESSION_ID, source: 'TERM_SESSION_ID', reliable: true };
  }

  // 3. iTerm2 specific (fallback)
  if (process.env.ITERM_SESSION_ID) {
    return { id: process.env.ITERM_SESSION_ID, source: 'ITERM_SESSION_ID', reliable: true };
  }

  // 4. Linux/Unix: Controlling TTY (works on X11, Wayland, tmux, etc.)
  const tty = getControllingTty();
  if (tty) {
    return { id: tty, source: 'CONTROLLING_TTY', reliable: true };
  }

  // 5. Linux X11 window ID (less reliable than TTY but still useful)
  if (process.env.WINDOWID) {
    return { id: `x11-${process.env.WINDOWID}`, source: 'WINDOWID', reliable: true };
  }

  // 6. Fallback: PID-based (unreliable for concurrent sessions)
  return {
    id: `fallback-${process.ppid || process.pid}`,
    source: 'FALLBACK_PID',
    reliable: false
  };
}

/**
 * Get full session info for current terminal
 * @returns {Object|null} Session data or null if not found
 */
function getSessionInfo() {
  const terminalInfo = getTerminalId();
  const sessionFile = path.join(sessionsDir, `${terminalInfo.id}.json`);

  try {
    const content = fs.readFileSync(sessionFile, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

/**
 * Get just the session ID for current terminal
 * @returns {string|null} Session ID or null if not found
 */
function getSessionId() {
  const info = getSessionInfo();
  return info ? info.sessionId : null;
}

/**
 * Check if running with a reliable terminal identifier
 * @returns {boolean} True if using reliable identifier
 */
function hasReliableTerminalId() {
  const info = getTerminalId();
  return info.reliable;
}

/**
 * Get the sessions directory path
 * @returns {string} Path to sessions directory
 */
function getSessionsDir() {
  return sessionsDir;
}

/**
 * Get the claude-afk directory path
 * @returns {string} Path to claude-afk directory
 */
function getClaudeAfkDir() {
  return path.join(claudeDir, 'claude-afk');
}

module.exports = {
  getTerminalId,
  getSessionInfo,
  getSessionId,
  hasReliableTerminalId,
  getControllingTty,
  getSessionsDir,
  getClaudeAfkDir
};
