// Transcript parser tests - TDD approach
// These tests define the contract for transcript.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getLastClaudeMessage,
  getLineCount,
  findToolResult,
  findUserMessage,
  getFileMtime,
  findSubagentTranscripts,
  getLastToolUse
} = require('./transcript.js');

describe('transcript parser', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tempFile = path.join(tempDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('extracts last assistant message from transcript', async () => {
    const transcript = [
      '{"type":"user","message":{"role":"user","content":"Fix the bug"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"I\'ll fix that now."}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Done! The bug is fixed."}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, "Done! The bug is fixed.");
  });

  it('handles array content blocks', async () => {
    const transcript = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}]}}';

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, "Part 1\nPart 2");
  });

  it('returns null for empty transcript', async () => {
    fs.writeFileSync(tempFile, '');

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, null);
  });

  it('returns null when no assistant messages', async () => {
    const transcript = '{"type":"user","message":{"role":"user","content":"Hello"}}';

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, null);
  });

  it('returns null on parse error (safe mode)', async () => {
    fs.writeFileSync(tempFile, 'not valid json');

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, null); // Doesn't throw
  });

  it('returns null when file does not exist', async () => {
    const result = await getLastClaudeMessage('/nonexistent/path/transcript.jsonl');
    assert.strictEqual(result, null);
  });

  it('skips non-assistant entries (summary, file-history-snapshot, user)', async () => {
    const transcript = [
      '{"type":"summary","content":"Previous conversation summary"}',
      '{"type":"file-history-snapshot","files":["file1.js"]}',
      '{"type":"user","message":{"role":"user","content":"Question"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Answer"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, "Answer");
  });

  it('handles mixed content blocks (text and non-text)', async () => {
    const transcript = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"},{"type":"text","text":"Running command..."},{"type":"tool_result","result":"ok"}]}}';

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, "Running command...");
  });

  it('handles trailing newlines in transcript', async () => {
    const transcript = '{"type":"assistant","message":{"role":"assistant","content":"Hello"}}\n\n\n';

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile);
    assert.strictEqual(result, "Hello");
  });

  it('truncates very long messages for notification', async () => {
    const longContent = 'A'.repeat(3000);
    const transcript = `{"type":"assistant","message":{"role":"assistant","content":"${longContent}"}}`;

    fs.writeFileSync(tempFile, transcript);

    const result = await getLastClaudeMessage(tempFile, { maxLength: 500 });
    assert.ok(result.length <= 500);
    assert.ok(result.endsWith('...'));
  });
});

describe('getLineCount', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tempFile = path.join(tempDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) { }
  });

  it('returns count of non-empty lines', async () => {
    const transcript = [
      '{"type":"user","message":{"content":"Line 1"}}',
      '{"type":"assistant","message":{"content":"Line 2"}}',
      '{"type":"user","message":{"content":"Line 3"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const count = await getLineCount(tempFile);
    assert.strictEqual(count, 3);
  });

  it('ignores empty lines', async () => {
    const transcript = '{"type":"user"}\n\n\n{"type":"assistant"}\n\n';
    fs.writeFileSync(tempFile, transcript);
    const count = await getLineCount(tempFile);
    assert.strictEqual(count, 2);
  });

  it('returns 0 for empty file', async () => {
    fs.writeFileSync(tempFile, '');
    const count = await getLineCount(tempFile);
    assert.strictEqual(count, 0);
  });

  it('returns 0 when file does not exist (safe mode)', async () => {
    const count = await getLineCount('/nonexistent/file.jsonl');
    assert.strictEqual(count, 0);
  });
});

describe('findToolResult', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tempFile = path.join(tempDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) { }
  });

  it('finds tool_result with matching tool_use_id', async () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-123","name":"Bash"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-123","is_error":false}]}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findToolResult(tempFile, 'tool-123', 0);

    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.isError, false);
    assert.strictEqual(result.offset, 2);
  });

  it('detects denied permission (is_error: true)', async () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-456","name":"Write"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-456","is_error":true}]}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findToolResult(tempFile, 'tool-456', 0);

    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.isError, true);
  });

  it('returns not found when tool_use_id does not match', async () => {
    const transcript = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"other-id","is_error":false}]}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await findToolResult(tempFile, 'tool-123', 0);

    assert.ok(result);
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.offset, 1);
  });

  it('searches only after specified offset', async () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-123","is_error":false}]}}',
      '{"type":"user","message":{"content":"More stuff"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-456","is_error":false}]}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findToolResult(tempFile, 'tool-456', 1);

    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.offset, 3);
  });

  it('returns null when file does not exist (safe mode)', async () => {
    const result = await findToolResult('/nonexistent/file.jsonl', 'tool-123', 0);
    assert.strictEqual(result, null);
  });

  it('skips malformed JSON lines (safe mode)', async () => {
    const transcript = [
      'invalid json line',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-123","is_error":false}]}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findToolResult(tempFile, 'tool-123', 0);

    assert.ok(result);
    assert.strictEqual(result.found, true);
  });

  it('handles multiple tool_result blocks in same message', async () => {
    const transcript = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","is_error":false},{"type":"tool_result","tool_use_id":"tool-2","is_error":true}]}}';

    fs.writeFileSync(tempFile, transcript);

    const result1 = await findToolResult(tempFile, 'tool-1', 0);
    assert.ok(result1?.found);
    assert.strictEqual(result1.isError, false);

    const result2 = await findToolResult(tempFile, 'tool-2', 0);
    assert.ok(result2?.found);
    assert.strictEqual(result2.isError, true);
  });

  it('handles mixed content blocks (text, tool_use, tool_result)', async () => {
    const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Running..."},{"type":"tool_use","id":"x","name":"Bash"},{"type":"tool_result","tool_use_id":"tool-123","is_error":false}]}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await findToolResult(tempFile, 'tool-123', 0);

    assert.ok(result?.found);
    assert.strictEqual(result.isError, false);
  });
});

describe('findUserMessage', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tempFile = path.join(tempDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) { }
  });

  it('finds user message with STRING content', async () => {
    const transcript = [
      '{"type":"assistant","message":{"content":"Claude response"}}',
      '{"type":"user","message":{"content":"User follow-up"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findUserMessage(tempFile, 0);

    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.content, 'User follow-up');
    assert.strictEqual(result.offset, 2);
  });

  it('ignores user messages with ARRAY content (tool_result arrays)', async () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"result"}]}}',
      '{"type":"user","message":{"content":"Real user message"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findUserMessage(tempFile, 0);

    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.content, 'Real user message');
    assert.strictEqual(result.offset, 2);
  });

  it('searches only after specified offset', async () => {
    const transcript = [
      '{"type":"user","message":{"content":"First message"}}',
      '{"type":"assistant","message":{"content":"Response"}}',
      '{"type":"user","message":{"content":"Second message"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findUserMessage(tempFile, 1);

    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.content, 'Second message');
  });

  it('returns not found when no user message after offset', async () => {
    const transcript = '{"type":"assistant","message":{"content":"Only assistant"}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await findUserMessage(tempFile, 0);

    assert.ok(result);
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.content, '');
  });

  it('returns null when file does not exist (safe mode)', async () => {
    const result = await findUserMessage('/nonexistent/file.jsonl', 0);
    assert.strictEqual(result, null);
  });

  it('ignores empty string content', async () => {
    const transcript = [
      '{"type":"user","message":{"content":""}}',
      '{"type":"user","message":{"content":"Real message"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findUserMessage(tempFile, 0);

    assert.ok(result?.found);
    assert.strictEqual(result.content, 'Real message');
  });

  it('ignores whitespace-only content', async () => {
    const transcript = [
      '{"type":"user","message":{"content":"   \\n\\t  "}}',
      '{"type":"user","message":{"content":"Real message"}}'
    ].join('\n');

    fs.writeFileSync(tempFile, transcript);
    const result = await findUserMessage(tempFile, 0);

    assert.ok(result?.found);
    assert.strictEqual(result.content, 'Real message');
  });
});

describe('getFileMtime', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tempFile = path.join(tempDir, 'test.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) { }
  });

  it('returns modification time in milliseconds', async () => {
    const before = Date.now();
    fs.writeFileSync(tempFile, 'content');
    const mtime = await getFileMtime(tempFile);
    const after = Date.now();

    assert.ok(typeof mtime === 'number');
    assert.ok(mtime > 0);
    // Allow for small timing variations (within 1 second before and 1 second after)
    assert.ok(mtime >= before - 1000 && mtime <= after + 1000);
  });

  it('returns null when file does not exist (safe mode)', async () => {
    const mtime = await getFileMtime('/nonexistent/file.jsonl');
    assert.strictEqual(mtime, null);
  });
});

describe('findSubagentTranscripts', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) { }
  });

  it('finds agent-*.jsonl files in same directory as main transcript', async () => {
    const mainTranscript = path.join(tempDir, 'session-123.jsonl');
    fs.writeFileSync(mainTranscript, '');
    fs.writeFileSync(path.join(tempDir, 'agent-abc.jsonl'), '');
    fs.writeFileSync(path.join(tempDir, 'agent-def.jsonl'), '');
    fs.writeFileSync(path.join(tempDir, 'other-file.txt'), '');

    const agentFiles = await findSubagentTranscripts(mainTranscript);

    assert.strictEqual(agentFiles.length, 2);
    assert.ok(agentFiles.some(f => f.endsWith('agent-abc.jsonl')));
    assert.ok(agentFiles.some(f => f.endsWith('agent-def.jsonl')));
    assert.ok(!agentFiles.some(f => f.endsWith('other-file.txt')));
  });

  it('returns empty array when no agent files exist', async () => {
    const mainTranscript = path.join(tempDir, 'session-123.jsonl');
    fs.writeFileSync(mainTranscript, '');

    const agentFiles = await findSubagentTranscripts(mainTranscript);
    assert.strictEqual(agentFiles.length, 0);
  });

  it('returns empty array when directory does not exist (safe mode)', async () => {
    const agentFiles = await findSubagentTranscripts('/nonexistent/dir/session.jsonl');
    assert.strictEqual(agentFiles.length, 0);
  });

  it('returns absolute paths', async () => {
    const mainTranscript = path.join(tempDir, 'session-123.jsonl');
    fs.writeFileSync(mainTranscript, '');
    fs.writeFileSync(path.join(tempDir, 'agent-abc.jsonl'), '');

    const agentFiles = await findSubagentTranscripts(mainTranscript);

    assert.strictEqual(agentFiles.length, 1);
    assert.ok(path.isAbsolute(agentFiles[0]));
    assert.ok(agentFiles[0].includes(tempDir));
  });

  it('filters out non-agent files correctly', async () => {
    const mainTranscript = path.join(tempDir, 'session-123.jsonl');
    fs.writeFileSync(mainTranscript, '');
    fs.writeFileSync(path.join(tempDir, 'agent-abc.jsonl'), '');
    fs.writeFileSync(path.join(tempDir, 'agent-def.txt'), ''); // Wrong extension
    fs.writeFileSync(path.join(tempDir, 'other.jsonl'), ''); // Wrong prefix
    fs.writeFileSync(path.join(tempDir, 'agent-.jsonl'), ''); // Should this match? Yes, it starts with agent-

    const agentFiles = await findSubagentTranscripts(mainTranscript);

    assert.strictEqual(agentFiles.length, 2); // agent-abc.jsonl and agent-.jsonl
    assert.ok(agentFiles.some(f => f.endsWith('agent-abc.jsonl')));
    assert.ok(!agentFiles.some(f => f.endsWith('agent-def.txt')));
    assert.ok(!agentFiles.some(f => f.endsWith('other.jsonl')));
  });
});

describe('getLastToolUse', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tempFile = path.join(tempDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (e) { }
  });

  it('returns id, tool, and input from tool_use block', async () => {
    const transcript = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-abc-123","name":"Bash","input":{"command":"ls -la"}}]}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await getLastToolUse(tempFile);

    assert.ok(result);
    assert.strictEqual(result.id, 'tool-abc-123');
    assert.strictEqual(result.tool, 'Bash');
    assert.deepStrictEqual(result.input, { command: 'ls -la' });
  });

  it('returns null when no tool_use found', async () => {
    const transcript = '{"type":"assistant","message":{"content":"Just text"}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await getLastToolUse(tempFile);

    assert.strictEqual(result, null);
  });

  it('returns last tool_use when multiple in same message', async () => {
    const transcript = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file":"a.txt"}},{"type":"tool_use","id":"tool-2","name":"Bash","input":{"command":"ls"}}]}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await getLastToolUse(tempFile);

    assert.ok(result);
    assert.strictEqual(result.id, 'tool-2'); // Should return LAST tool_use
    assert.strictEqual(result.tool, 'Bash');
    assert.deepStrictEqual(result.input, { command: 'ls' });
  });

  it('handles missing input field (defaults to empty object)', async () => {
    const transcript = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-123","name":"Bash"}]}}';

    fs.writeFileSync(tempFile, transcript);
    const result = await getLastToolUse(tempFile);

    assert.ok(result);
    assert.strictEqual(result.id, 'tool-123');
    assert.strictEqual(result.tool, 'Bash');
    assert.deepStrictEqual(result.input, {});
  });
});
