#!/usr/bin/env node
/**
 * Payload Capture Utility
 *
 * Captures hook payloads and transcript snapshots for research.
 *
 * Usage:
 *   node scripts/payload-capture.js permission <input.json>
 *   node scripts/payload-capture.js stop <input.json>
 *   node scripts/payload-capture.js snapshot <transcript_path> <label>
 *   node scripts/payload-capture.js session <session_id>
 *
 * Outputs are saved to: ~/.claude/claude-afk/captures/
 */

const fs = require('fs');
const path = require('path');
const { getClaudeAfkDir } = require('./session-lookup');

const capturesDir = path.join(getClaudeAfkDir(), 'captures');

function ensureCapturesDir() {
  if (!fs.existsSync(capturesDir)) {
    fs.mkdirSync(capturesDir, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Capture a hook payload
 */
function capturePayload(hookType, payload) {
  ensureCapturesDir();

  const filename = `${timestamp()}_${hookType}_payload.json`;
  const filepath = path.join(capturesDir, filename);

  const capture = {
    capturedAt: new Date().toISOString(),
    hookType,
    payload,
    env: {
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDE_TRANSCRIPT_PATH: process.env.CLAUDE_TRANSCRIPT_PATH,
      CLAUDE_CWD: process.env.CLAUDE_CWD,
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT
    }
  };

  fs.writeFileSync(filepath, JSON.stringify(capture, null, 2));
  console.log(`Captured ${hookType} payload: ${filepath}`);

  return filepath;
}

/**
 * Capture a transcript snapshot
 */
function captureTranscript(transcriptPath, label) {
  ensureCapturesDir();

  if (!fs.existsSync(transcriptPath)) {
    console.error(`Transcript not found: ${transcriptPath}`);
    return null;
  }

  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.trim().split('\n').filter(l => l);

  // Parse each line as JSON
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push({
        lineNumber: i + 1,
        entry: JSON.parse(lines[i])
      });
    } catch (e) {
      entries.push({
        lineNumber: i + 1,
        parseError: e.message,
        raw: lines[i].substring(0, 200) + (lines[i].length > 200 ? '...' : '')
      });
    }
  }

  const filename = `${timestamp()}_transcript_${label}.json`;
  const filepath = path.join(capturesDir, filename);

  const stat = fs.statSync(transcriptPath);

  const capture = {
    capturedAt: new Date().toISOString(),
    label,
    transcriptPath,
    fileStat: {
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs
    },
    lineCount: lines.length,
    entries
  };

  fs.writeFileSync(filepath, JSON.stringify(capture, null, 2));
  console.log(`Captured transcript (${lines.length} lines): ${filepath}`);

  return filepath;
}

/**
 * Capture session info
 */
function captureSession(sessionId) {
  ensureCapturesDir();

  const claudeDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude');
  const sessionsDir = path.join(claudeDir, 'sessions');

  const capture = {
    capturedAt: new Date().toISOString(),
    sessionId,
    files: {}
  };

  // Look for session files in various locations
  const locations = [
    path.join(sessionsDir, 'by-terminal'),
    path.join(sessionsDir, 'by-id'),
    sessionsDir
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      try {
        const files = fs.readdirSync(loc);
        for (const file of files) {
          if (file.includes(sessionId) || file.endsWith('.json')) {
            const filepath = path.join(loc, file);
            const stat = fs.statSync(filepath);
            if (stat.isFile() && stat.size < 1000000) { // Skip large files
              try {
                const content = fs.readFileSync(filepath, 'utf8');
                capture.files[filepath] = {
                  size: stat.size,
                  mtime: stat.mtime.toISOString(),
                  content: JSON.parse(content)
                };
              } catch (e) {
                capture.files[filepath] = {
                  size: stat.size,
                  mtime: stat.mtime.toISOString(),
                  parseError: e.message
                };
              }
            }
          }
        }
      } catch (e) {
        capture.files[loc] = { error: e.message };
      }
    }
  }

  const filename = `${timestamp()}_session_${sessionId.substring(0, 8)}.json`;
  const filepath = path.join(capturesDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(capture, null, 2));
  console.log(`Captured session info: ${filepath}`);

  return filepath;
}

/**
 * List all captures
 */
function listCaptures() {
  ensureCapturesDir();

  const files = fs.readdirSync(capturesDir).sort().reverse();

  if (files.length === 0) {
    console.log('No captures found.');
    return;
  }

  console.log(`\nCaptures in ${capturesDir}:\n`);

  for (const file of files) {
    const filepath = path.join(capturesDir, file);
    const stat = fs.statSync(filepath);
    console.log(`  ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
  }

  console.log(`\nTotal: ${files.length} captures`);
}

// CLI
const [,, command, ...args] = process.argv;

switch (command) {
  case 'permission':
  case 'stop': {
    const inputFile = args[0];
    if (!inputFile) {
      // Read from stdin
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        try {
          const payload = JSON.parse(input);
          capturePayload(command, payload);
        } catch (e) {
          console.error('Failed to parse input:', e.message);
          process.exit(1);
        }
      });
    } else {
      const content = fs.readFileSync(inputFile, 'utf8');
      const payload = JSON.parse(content);
      capturePayload(command, payload);
    }
    break;
  }

  case 'snapshot': {
    const [transcriptPath, label = 'snapshot'] = args;
    if (!transcriptPath) {
      console.error('Usage: payload-capture.js snapshot <transcript_path> [label]');
      process.exit(1);
    }
    captureTranscript(transcriptPath, label);
    break;
  }

  case 'session': {
    const [sessionId] = args;
    if (!sessionId) {
      console.error('Usage: payload-capture.js session <session_id>');
      process.exit(1);
    }
    captureSession(sessionId);
    break;
  }

  case 'list': {
    listCaptures();
    break;
  }

  default:
    console.log(`
Payload Capture Utility

Commands:
  permission <input.json>              Capture PermissionRequest hook payload
  stop <input.json>                    Capture Stop hook payload
  snapshot <transcript_path> [label]   Capture transcript snapshot
  session <session_id>                 Capture session files
  list                                 List all captures

Outputs saved to: ${capturesDir}
    `);
}

module.exports = {
  capturePayload,
  captureTranscript,
  captureSession,
  capturesDir
};
