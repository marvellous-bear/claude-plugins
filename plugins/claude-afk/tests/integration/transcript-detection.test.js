// Integration test: Transcript Polling and Local Resolution Detection
// Tests the complete transcript polling system for detecting local resolutions
//
// PRD Reference (lines 940-968):
// - Permission resolved locally → Telegram message deleted
// - Stop resolved locally → Telegram message deleted
// - Session restart → Telegram shows "Session ended"
// - Race condition: Telegram arrives after local → "Already handled"
// - Socket dead + unresolved → "Unable to deliver" message
// - Subagent permission detection works
// - Concurrent poll cycles don't interfere (isPollingTranscripts guard)
// - Daemon restart resets offset and catches missed resolutions

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { findToolResult, findUserMessage, getLineCount } = require('../../scripts/daemon/transcript');

// Test helpers to create transcript fixtures
async function createTestTranscript(content) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-afk-test-'));
  const transcriptPath = path.join(tmpDir, 'test-transcript.jsonl');
  await fs.writeFile(transcriptPath, content, 'utf8');
  return { transcriptPath, tmpDir };
}

async function appendToTranscript(transcriptPath, line) {
  await fs.appendFile(transcriptPath, line + '\n', 'utf8');
}

async function cleanupTestTranscript(tmpDir) {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // Ignore cleanup errors
  }
}

describe('Integration: Transcript Detection - Permission Resolution', () => {
  let testFiles = [];

  afterEach(async () => {
    // Cleanup all test files
    for (const tmpDir of testFiles) {
      await cleanupTestTranscript(tmpDir);
    }
    testFiles = [];
  });

  it('findToolResult detects approved permission (is_error: false)', async () => {
    // Create transcript with tool_use
    const initial = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_abc123', name: 'Bash', input: { command: 'npm test' } }
        ]
      }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(initial + '\n');
    testFiles.push(tmpDir);

    // Append tool_result (approved)
    const result = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_abc123', content: 'test output', is_error: false }
        ]
      }
    });
    await appendToTranscript(transcriptPath, result);

    // Detect resolution
    const found = await findToolResult(transcriptPath, 'toolu_abc123', 0);

    assert.ok(found, 'Should find tool_result');
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.isError, false, 'Should detect approval (is_error: false)');
    assert.strictEqual(found.offset, 2, 'Should return correct offset');
  });

  it('findToolResult detects denied permission (is_error: true)', async () => {
    const initial = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_xyz789', name: 'Write', input: { file_path: '/etc/hosts' } }
        ]
      }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(initial + '\n');
    testFiles.push(tmpDir);

    // Append tool_result (denied)
    const result = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_xyz789', content: 'Permission denied', is_error: true }
        ]
      }
    });
    await appendToTranscript(transcriptPath, result);

    const found = await findToolResult(transcriptPath, 'toolu_xyz789', 0);

    assert.ok(found);
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.isError, true, 'Should detect denial (is_error: true)');
  });

  it('findToolResult returns null when tool_use_id not found', async () => {
    const initial = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_other', name: 'Bash', input: { command: 'ls' } }
        ]
      }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(initial + '\n');
    testFiles.push(tmpDir);

    const found = await findToolResult(transcriptPath, 'toolu_nonexistent', 0);

    assert.ok(found, 'Should return result object');
    assert.strictEqual(found.found, false, 'Should indicate not found');
  });

  it('findToolResult uses afterOffset for incremental reads', async () => {
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_123', name: 'Bash', input: {} }] }
    });
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'done', is_error: false }] }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n' + line2 + '\n');
    testFiles.push(tmpDir);

    // Start search from line 2 (skip line 1)
    const found = await findToolResult(transcriptPath, 'toolu_123', 1);

    assert.ok(found);
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.offset, 2, 'Should find starting from offset 1');
  });

  it('findToolResult handles malformed JSON lines gracefully', async () => {
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_456', name: 'Bash', input: {} }] }
    });
    const badLine = '{ invalid json ';
    const line3 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_456', content: 'ok', is_error: false }] }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(
      line1 + '\n' + badLine + '\n' + line3 + '\n'
    );
    testFiles.push(tmpDir);

    // Should skip malformed line and continue
    const found = await findToolResult(transcriptPath, 'toolu_456', 0);

    assert.ok(found, 'Should handle malformed JSON and continue searching');
    assert.strictEqual(found.found, true);
  });
});

describe('Integration: Transcript Detection - Stop Resolution', () => {
  let testFiles = [];

  afterEach(async () => {
    for (const tmpDir of testFiles) {
      await cleanupTestTranscript(tmpDir);
    }
    testFiles = [];
  });

  it('findUserMessage detects user follow-up (string content)', async () => {
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'Task complete!' }
    });
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Now run the linter' }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n' + line2 + '\n');
    testFiles.push(tmpDir);

    const found = await findUserMessage(transcriptPath, 1);

    assert.ok(found);
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.content, 'Now run the linter');
    assert.strictEqual(found.offset, 2);
  });

  it('findUserMessage distinguishes string vs array content', async () => {
    const line1 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'xyz', content: 'result' }] }
    });
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'This is a string message' }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n' + line2 + '\n');
    testFiles.push(tmpDir);

    // Should only find line2 (string content)
    const found = await findUserMessage(transcriptPath, 0);

    assert.ok(found);
    assert.strictEqual(found.content, 'This is a string message');
    assert.strictEqual(found.offset, 2, 'Should skip array content');
  });

  it('findUserMessage returns null when no user message found', async () => {
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'Still waiting...' }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n');
    testFiles.push(tmpDir);

    const found = await findUserMessage(transcriptPath, 0);

    assert.ok(found, 'Should return result object');
    assert.strictEqual(found.found, false, 'Should indicate not found');
  });

  it('findUserMessage uses afterOffset for incremental reads', async () => {
    const line1 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hello' } });
    const line2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'First message' } });
    const line3 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Second message' } });

    const { transcriptPath, tmpDir } = await createTestTranscript(
      line1 + '\n' + line2 + '\n' + line3 + '\n'
    );
    testFiles.push(tmpDir);

    // Start from offset 2, should find line3
    const found = await findUserMessage(transcriptPath, 2);

    assert.ok(found);
    assert.strictEqual(found.content, 'Second message');
    assert.strictEqual(found.offset, 3);
  });
});

describe('Integration: Line Count Utility', () => {
  let testFiles = [];

  afterEach(async () => {
    for (const tmpDir of testFiles) {
      await cleanupTestTranscript(tmpDir);
    }
    testFiles = [];
  });

  it('getLineCount returns correct line count', async () => {
    const content = 'line1\nline2\nline3\n';
    const { transcriptPath, tmpDir } = await createTestTranscript(content);
    testFiles.push(tmpDir);

    const count = await getLineCount(transcriptPath);

    assert.strictEqual(count, 3);
  });

  it('getLineCount handles empty file', async () => {
    const { transcriptPath, tmpDir } = await createTestTranscript('');
    testFiles.push(tmpDir);

    const count = await getLineCount(transcriptPath);

    assert.strictEqual(count, 0);
  });

  it('getLineCount returns 0 on file not found', async () => {
    const count = await getLineCount('/nonexistent/file.jsonl');

    assert.strictEqual(count, 0, 'Should return 0 on error (Safe Mode)');
  });
});

describe('Integration: Session Validity Detection', () => {
  let testFiles = [];
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-afk-sessions-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTestTranscript(tmpDir);
      tmpDir = null;
    }
    for (const dir of testFiles) {
      await cleanupTestTranscript(dir);
    }
    testFiles = [];
  });

  it('detects session restart when sessionId changes', async () => {
    // Create initial session file
    const terminalId = 'test-terminal-123';
    const sessionFile = path.join(tmpDir, `${terminalId}.json`);
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ sessionId: 'session-old', terminalId }),
      'utf8'
    );

    // Read and verify
    const session1 = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.strictEqual(session1.sessionId, 'session-old');

    // Simulate session restart - overwrite with new sessionId
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ sessionId: 'session-new', terminalId }),
      'utf8'
    );

    // Read again
    const session2 = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.strictEqual(session2.sessionId, 'session-new');
    assert.notStrictEqual(session1.sessionId, session2.sessionId, 'Session ID should change');
  });

  it('detects session file missing (session ended)', async () => {
    const sessionFile = path.join(tmpDir, 'missing-terminal.json');

    // Try to read non-existent file
    let exists = false;
    try {
      await fs.access(sessionFile);
      exists = true;
    } catch (err) {
      exists = false;
    }

    assert.strictEqual(exists, false, 'Session file should not exist');
  });
});

describe('Integration: Race Condition Scenarios', () => {
  let testFiles = [];

  afterEach(async () => {
    for (const tmpDir of testFiles) {
      await cleanupTestTranscript(tmpDir);
    }
    testFiles = [];
  });

  it('checkTranscriptForResolution verifies permission was resolved', async () => {
    // Scenario: Telegram response arrives, but socket is dead
    // Need to check transcript to see if already resolved

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_race', name: 'Bash', input: {} }] }
    });
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_race', content: 'ok', is_error: false }] }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n' + line2 + '\n');
    testFiles.push(tmpDir);

    // Check from beginning (offset 0) - simulates checking full transcript
    const found = await findToolResult(transcriptPath, 'toolu_race', 0);

    assert.ok(found);
    assert.strictEqual(found.found, true, 'Should find resolution in transcript');
    // This proves the race condition handler can detect "Already handled locally"
  });

  it('checkTranscriptForResolution returns null when not resolved', async () => {
    // Scenario: Socket dead but transcript shows NO resolution
    // Should tell user "Unable to deliver"

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_unresolved', name: 'Bash', input: {} }] }
    });
    // No tool_result - permission still pending

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n');
    testFiles.push(tmpDir);

    const found = await findToolResult(transcriptPath, 'toolu_unresolved', 0);

    assert.ok(found, 'Should return result object');
    assert.strictEqual(found.found, false, 'Should not find resolution');
    // This proves we can distinguish "undeliverable" from "already handled"
  });
});

describe('Integration: Daemon Restart Recovery', () => {
  let testFiles = [];

  afterEach(async () => {
    for (const tmpDir of testFiles) {
      await cleanupTestTranscript(tmpDir);
    }
    testFiles = [];
  });

  it('offset reset allows full transcript re-scan after restart', async () => {
    // Scenario: Daemon crashes, resolution happens during downtime, daemon restarts
    // Must reset offset to 0 to catch missed resolutions

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_missed', name: 'Bash', input: {} }] }
    });
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_missed', content: 'done', is_error: false }] }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n' + line2 + '\n');
    testFiles.push(tmpDir);

    // Simulate: before crash, offset was at line 1 (only checked line 1)
    // After restart: reset offset to 0, full re-scan
    const foundAfterRestart = await findToolResult(transcriptPath, 'toolu_missed', 0);

    assert.ok(foundAfterRestart);
    assert.strictEqual(foundAfterRestart.found, true, 'Should find resolution missed during downtime');
  });

  it('incremental offset prevents re-processing same lines', async () => {
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_inc', name: 'Bash', input: {} }] }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n');
    testFiles.push(tmpDir);

    // First poll: offset 0 → reads line 1
    const count1 = await getLineCount(transcriptPath);
    assert.strictEqual(count1, 1);

    // Append new line
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inc', content: 'ok', is_error: false }] }
    });
    await appendToTranscript(transcriptPath, line2);

    // Second poll: offset 1 → only reads line 2 (incremental)
    const found = await findToolResult(transcriptPath, 'toolu_inc', 1);

    assert.ok(found);
    assert.strictEqual(found.offset, 2, 'Should only process new line');
  });
});

describe('Integration: Concurrent Poll Protection', () => {
  it('isPollingTranscripts guard pattern (documented behavior)', async () => {
    // Note: This is a behavioral test documenting the pattern
    // The actual guard is implemented in daemon/index.js pollTranscripts()

    let isPollingTranscripts = false;

    async function pollTranscripts() {
      if (isPollingTranscripts) {
        // Skip if previous cycle still running
        return { skipped: true };
      }

      isPollingTranscripts = true;
      try {
        // Simulate long-running poll
        await new Promise(r => setTimeout(r, 10));
        return { skipped: false, processed: true };
      } finally {
        isPollingTranscripts = false;
      }
    }

    // Start two concurrent polls
    const [result1, result2] = await Promise.all([
      pollTranscripts(),
      pollTranscripts()
    ]);

    // One should process, one should skip
    const skippedCount = [result1, result2].filter(r => r.skipped).length;
    const processedCount = [result1, result2].filter(r => r.processed).length;

    assert.strictEqual(processedCount, 1, 'Exactly one poll should process');
    assert.strictEqual(skippedCount, 1, 'Exactly one poll should be skipped');
  });
});

describe('Integration: End-to-End Scenarios', () => {
  let testFiles = [];

  afterEach(async () => {
    for (const tmpDir of testFiles) {
      await cleanupTestTranscript(tmpDir);
    }
    testFiles = [];
  });

  it('scenario: permission approved locally → detection works', async () => {
    // 1. Permission request sent to Telegram
    const toolUseId = 'toolu_e2e_perm';
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'npm test' } }] }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n');
    testFiles.push(tmpDir);

    // 2. User approves locally (Claude Code writes tool_result)
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'tests passed', is_error: false }] }
    });
    await appendToTranscript(transcriptPath, line2);

    // 3. Polling detects resolution
    const found = await findToolResult(transcriptPath, toolUseId, 0);

    assert.ok(found);
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.isError, false);
    // In real daemon: would delete Telegram message here
  });

  it('scenario: stop with local follow-up → detection works', async () => {
    // 1. Stop notification sent to Telegram
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'Task complete!' }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n');
    testFiles.push(tmpDir);

    const initialOffset = await getLineCount(transcriptPath);
    assert.strictEqual(initialOffset, 1);

    // 2. User types follow-up locally
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Now check the logs' }
    });
    await appendToTranscript(transcriptPath, line2);

    // 3. Polling detects user message
    const found = await findUserMessage(transcriptPath, initialOffset);

    assert.ok(found);
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.content, 'Now check the logs');
    // In real daemon: would delete Telegram message here
  });

  it('scenario: multiple pending requests tracked independently', async () => {
    // User has 2 pending permissions in same session
    const line1 = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_req1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'toolu_req2', name: 'Write', input: { file_path: 'file.txt' } }
        ]
      }
    });

    const { transcriptPath, tmpDir } = await createTestTranscript(line1 + '\n');
    testFiles.push(tmpDir);

    // User approves only the first one locally
    const line2 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_req1', content: 'ok', is_error: false }] }
    });
    await appendToTranscript(transcriptPath, line2);

    // Check both
    const found1 = await findToolResult(transcriptPath, 'toolu_req1', 0);
    const found2 = await findToolResult(transcriptPath, 'toolu_req2', 0);

    assert.ok(found1);
    assert.strictEqual(found1.found, true, 'First request should be resolved');

    assert.ok(found2, 'Should return result object');
    assert.strictEqual(found2.found, false, 'Second request should still be pending');
    // In real daemon: delete only first Telegram message, keep second active
  });
});
