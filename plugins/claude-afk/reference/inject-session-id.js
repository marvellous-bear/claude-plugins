#!/usr/bin/env node
// SessionStart hook - create terminal-keyed session registry
// Allows concurrent Claude Code sessions in different terminals

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const claudeDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude');
const sessionsDir = path.join(claudeDir, 'sessions', 'by-terminal');
const debugFile = path.join(claudeDir, 'hook-debug.log');

// Get controlling TTY on Linux/Unix (works even when stdio is piped)
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

// Get terminal identifier (works across platforms)
function getTerminalId() {
  // 1. Windows Terminal (Windows + WSL via WSLENV) - Excellent
  if (process.env.WT_SESSION) {
    return { id: process.env.WT_SESSION, source: 'WT_SESSION' };
  }
  
  // 2. macOS Terminal.app and iTerm2 - Excellent
  if (process.env.TERM_SESSION_ID) {
    return { id: process.env.TERM_SESSION_ID, source: 'TERM_SESSION_ID' };
  }
  
  // 3. iTerm2 specific (fallback)
  if (process.env.ITERM_SESSION_ID) {
    return { id: process.env.ITERM_SESSION_ID, source: 'ITERM_SESSION_ID' };
  }
  
  // 4. Linux/Unix: Controlling TTY (works on X11, Wayland, tmux, etc.)
  const tty = getControllingTty();
  if (tty) {
    return { id: tty, source: 'CONTROLLING_TTY' };
  }
  
  // 5. Linux X11 window ID (less reliable than TTY but still useful)
  if (process.env.WINDOWID) {
    return { id: `x11-${process.env.WINDOWID}`, source: 'WINDOWID' };
  }
  
  // 6. Fallback: PID-based (unreliable for concurrent sessions)
  return { id: `fallback-${process.ppid || process.pid}`, source: 'FALLBACK_PID' };
}

// Collect all available terminal identifiers for debugging
function getAvailableIdentifiers() {
  return {
    WT_SESSION: process.env.WT_SESSION || null,
    TERM_SESSION_ID: process.env.TERM_SESSION_ID || null,
    ITERM_SESSION_ID: process.env.ITERM_SESSION_ID || null,
    WINDOWID: process.env.WINDOWID || null,
    CONTROLLING_TTY: getControllingTty(),
    XDG_SESSION_ID: process.env.XDG_SESSION_ID || null,
    TERM: process.env.TERM || null,
    PPID: process.ppid || null,
    PID: process.pid || null
  };
}

let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;
    const terminalInfo = getTerminalId();
    const terminalId = terminalInfo.id;

    // Ensure sessions directory exists
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Write session mapping
    const sessionFile = path.join(sessionsDir, terminalId);
    const sessionData = {
      sessionId: sessionId,
      transcriptPath: data.transcript_path,
      cwd: data.cwd,
      startedAt: new Date().toISOString(),
      terminalId: terminalId,
      terminalIdSource: terminalInfo.source
    };
    fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));

    // Also write to CLAUDE_ENV_FILE if available (in case it starts working)
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      fs.appendFileSync(envFile, `export CLAUDE_SESSION_ID='${sessionId}'\n`);
      fs.appendFileSync(envFile, `export CLAUDE_TERMINAL_ID='${terminalId}'\n`);
    }

    // Debug log with all available identifiers
    fs.writeFileSync(debugFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId,
      terminalId,
      terminalIdSource: terminalInfo.source,
      sessionFile,
      transcriptPath: data.transcript_path,
      availableIdentifiers: getAvailableIdentifiers()
    }, null, 2));

    console.error(`Session registered: ${sessionId} for terminal ${terminalId} (via ${terminalInfo.source})`);
    process.exit(0);
  } catch (err) {
    fs.appendFileSync(debugFile, `\nError: ${err.message}\n${err.stack}\n`);
    console.error('Error:', err.message);
    process.exit(0);
  }
});
