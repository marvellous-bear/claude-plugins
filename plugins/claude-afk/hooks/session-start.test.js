// Session-start hook tests - TDD approach
// Tests for SessionStart hook that registers terminal→session mapping

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import the module functions for testing
const { createSessionStartHandler } = require('./session-start.js');

describe('session-start hook', () => {
  // Create temp directory for tests
  let tempDir;
  let sessionsDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-test-'));
    sessionsDir = path.join(tempDir, 'sessions', 'by-terminal');
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes session data to terminal-keyed file', async () => {
    const handler = createSessionStartHandler({
      sessionsDir,
      getTerminalId: () => ({ id: 'test-terminal-123', source: 'TEST', reliable: true })
    });

    const input = {
      session_id: 'abc-123-def',
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/home/user/my-project'
    };

    await handler.handle(input);

    const sessionFile = path.join(sessionsDir, 'test-terminal-123.json');
    assert.ok(fs.existsSync(sessionFile), 'Session file should exist');

    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.strictEqual(data.sessionId, 'abc-123-def');
    assert.strictEqual(data.transcriptPath, '/path/to/transcript.jsonl');
    assert.strictEqual(data.cwd, '/home/user/my-project');
    assert.strictEqual(data.terminalId, 'test-terminal-123');
    assert.strictEqual(data.terminalIdSource, 'TEST');
  });

  it('creates sessions directory if not exists', async () => {
    const newSessionsDir = path.join(tempDir, 'new', 'sessions', 'by-terminal');

    const handler = createSessionStartHandler({
      sessionsDir: newSessionsDir,
      getTerminalId: () => ({ id: 'term-1', source: 'TEST', reliable: true })
    });

    await handler.handle({ session_id: 'sess-1', transcript_path: '/t.jsonl', cwd: '/cwd' });

    assert.ok(fs.existsSync(path.join(newSessionsDir, 'term-1.json')));
  });

  it('overwrites existing session file for same terminal', async () => {
    const handler = createSessionStartHandler({
      sessionsDir,
      getTerminalId: () => ({ id: 'same-terminal', source: 'TEST', reliable: true })
    });

    await handler.handle({ session_id: 'old-session', transcript_path: '/old.jsonl', cwd: '/old' });
    await handler.handle({ session_id: 'new-session', transcript_path: '/new.jsonl', cwd: '/new' });

    const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'same-terminal.json'), 'utf8'));
    assert.strictEqual(data.sessionId, 'new-session');
    assert.strictEqual(data.transcriptPath, '/new.jsonl');
  });

  it('includes startedAt timestamp', async () => {
    const handler = createSessionStartHandler({
      sessionsDir,
      getTerminalId: () => ({ id: 'term-time', source: 'TEST', reliable: true })
    });

    const before = new Date().toISOString();
    await handler.handle({ session_id: 'sess', transcript_path: '/t.jsonl', cwd: '/cwd' });
    const after = new Date().toISOString();

    const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'term-time.json'), 'utf8'));
    assert.ok(data.startedAt >= before && data.startedAt <= after);
  });

  it('handles different terminal ID sources', async () => {
    const sources = [
      { id: 'wt-abc', source: 'WT_SESSION', reliable: true },
      { id: 'term-xyz', source: 'TERM_SESSION_ID', reliable: true },
      { id: 'pts-4', source: 'CONTROLLING_TTY', reliable: true },
      { id: 'fallback-123', source: 'FALLBACK_PID', reliable: false }
    ];

    for (const termInfo of sources) {
      const handler = createSessionStartHandler({
        sessionsDir,
        getTerminalId: () => termInfo
      });

      await handler.handle({ session_id: `sess-${termInfo.source}`, transcript_path: '/t.jsonl', cwd: '/cwd' });

      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${termInfo.id}.json`), 'utf8'));
      assert.strictEqual(data.terminalIdSource, termInfo.source);
    }
  });

  it('returns null on success (passthrough)', async () => {
    const handler = createSessionStartHandler({
      sessionsDir,
      getTerminalId: () => ({ id: 'term', source: 'TEST', reliable: true })
    });

    const result = await handler.handle({ session_id: 'sess', transcript_path: '/t.jsonl', cwd: '/cwd' });
    assert.strictEqual(result, null);
  });

  it('returns null on error (fail-open)', async () => {
    const handler = createSessionStartHandler({
      sessionsDir: '/nonexistent/readonly/path',
      getTerminalId: () => ({ id: 'term', source: 'TEST', reliable: true }),
      logError: () => {} // Suppress error logging in test
    });

    // Should not throw, should return null (passthrough)
    const result = await handler.handle({ session_id: 'sess', transcript_path: '/t.jsonl', cwd: '/cwd' });
    assert.strictEqual(result, null);
  });
});
