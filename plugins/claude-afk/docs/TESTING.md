# Testing Guide

This guide covers how to run tests, write new tests, and manually verify plugin functionality.

## Quick Reference

```bash
# Run all unit tests
npm test

# Run with watch mode (re-runs on file changes)
npm run test:watch

# Run integration tests
npm run test:integration

# Run everything
npm run test:all
```

---

## Test Structure

```
tests/
├── integration/               # End-to-end tests
│   ├── full-flow.test.js      # Complete workflow tests
│   ├── multi-session.test.js  # Concurrent session tests
│   └── transcript-detection.test.js
└── fixtures/                  # Test data
    └── sample-transcript.jsonl

scripts/
├── *.test.js                  # Unit tests alongside source
└── daemon/
    └── *.test.js              # Daemon component tests

hooks/
└── session-start.test.js      # Hook unit tests
```

### Test File Naming

- Unit tests: `{source-file}.test.js` (same directory as source)
- Integration tests: `tests/integration/{feature}.test.js`

---

## Unit Tests

Unit tests verify individual components in isolation using mocks.

### Running Unit Tests

```bash
npm test
```

### Writing Unit Tests

We use Node.js built-in test runner (no external frameworks).

**Example structure:**

```javascript
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('MyComponent', () => {
  beforeEach(() => {
    // Reset state before each test
  });

  it('should do something specific', async () => {
    // Arrange
    const input = { ... };

    // Act
    const result = await myFunction(input);

    // Assert
    assert.strictEqual(result.status, 'success');
  });
});
```

### Key Unit Test Files

| File | Tests |
|------|-------|
| `scripts/cli.test.js` | CLI command handling |
| `scripts/daemon/ipc.test.js` | IPC protocol and messaging |
| `scripts/daemon/sessions.test.js` | Session registry logic |
| `scripts/daemon/singleton.test.js` | File locking |
| `scripts/daemon/telegram.test.js` | Telegram API interactions |
| `scripts/daemon/transcript.test.js` | Transcript parsing |
| `scripts/permission-handler.test.js` | Permission hook logic |
| `scripts/stop-handler.test.js` | Stop hook logic |
| `hooks/session-start.test.js` | Session start hook |

---

## Integration Tests

Integration tests verify components working together with real (or simulated) daemon processes.

### Running Integration Tests

```bash
npm run test:integration
```

### What Integration Tests Cover

- Full permission request → approval → response flow
- Multi-session scenarios
- Daemon lifecycle (start, lock, cleanup)
- IPC communication between hooks and daemon

---

## Manual Testing

For testing with real Telegram integration, follow this checklist.

### Prerequisites

1. Plugin installed with Telegram token configured
2. Telegram app open on your phone
3. Fresh Claude Code session

### Test Checklist

#### 1. Setup Flow
- [ ] Run `/claude-afk:setup`
- [ ] Send `/start` to your bot in Telegram
- [ ] Verify "paired" confirmation

#### 2. Enable/Disable
- [ ] Run `/claude-afk:enable` — verify confirmation
- [ ] Run `/claude-afk:status` — verify "AFK mode enabled"
- [ ] Run `/claude-afk:disable` — verify confirmation
- [ ] Run `/claude-afk:status` — verify "AFK mode disabled"

#### 3. Permission Request (Approve)
- [ ] Enable AFK mode
- [ ] Ask Claude to create a file
- [ ] Verify Telegram notification shows:
  - Project name and session token
  - Context (what you asked Claude)
  - The specific command
  - Reply options
- [ ] Reply `yes` in Telegram
- [ ] Verify Claude proceeds and file is created

#### 4. Permission Request (Deny)
- [ ] Ask Claude to delete a file
- [ ] Verify Telegram notification
- [ ] Reply `no` in Telegram
- [ ] Verify Claude stops and reports denial

#### 5. Permission Request (Local Approval)
- [ ] Ask Claude to read a file
- [ ] Wait for Telegram notification
- [ ] Approve **locally in Claude Code** (not Telegram)
- [ ] Verify Telegram notification is deleted

#### 6. Bulk Approval
- [ ] Ask Claude to edit multiple files
- [ ] On first Edit request, reply `all`
- [ ] Verify subsequent Edit requests auto-approve (no notification)
- [ ] Disable AFK mode — whitelist should clear
- [ ] Re-enable and verify Edit requests prompt again

#### 7. Stop Hook (Follow-up)
- [ ] Give Claude a simple task: "List files in this directory"
- [ ] Wait for "task complete" Telegram notification
- [ ] Reply with follow-up: "Now count .js files"
- [ ] Verify Claude continues with new task

#### 8. Stop Hook (Timeout)
- [ ] Give Claude a simple task
- [ ] Wait for "task complete" notification
- [ ] Don't reply — wait 60 seconds
- [ ] Verify Claude stops gracefully

#### 9. Multi-Session
- [ ] Open two terminals in same project
- [ ] Enable AFK in both
- [ ] Trigger permission requests in both
- [ ] Verify each receives separate notifications with different tokens

### Cleanup

```
/claude-afk:disable
```

Delete any test files created.

---

## Debug Mode

Enable debug mode to capture hook payloads for troubleshooting:

**Windows (PowerShell):**
```powershell
$env:CLAUDE_AFK_DEBUG = "1"
```

**macOS/Linux:**
```bash
export CLAUDE_AFK_DEBUG=1
```

Captures are saved to `~/.claude/claude-afk/captures/`.

### Capture Commands

```bash
# List all captures
node scripts/payload-capture.js list

# Capture current transcript
node scripts/payload-capture.js snapshot /path/to/transcript.jsonl my_label

# View a capture
cat ~/.claude/claude-afk/captures/<filename>.json | jq .
```

---

## Writing New Tests

### Unit Test Template

```javascript
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

// Import the module under test
const { myFunction } = require('./my-module.js');

describe('myFunction', () => {
  let mockDependency;

  beforeEach(() => {
    // Create mocks
    mockDependency = mock.fn(() => 'mocked result');
  });

  afterEach(() => {
    // Clean up
    mock.reset();
  });

  it('should handle normal input', async () => {
    const result = await myFunction('input');
    assert.strictEqual(result, 'expected');
  });

  it('should handle edge case', async () => {
    const result = await myFunction(null);
    assert.strictEqual(result, 'default');
  });

  it('should throw on invalid input', async () => {
    await assert.rejects(
      () => myFunction('invalid'),
      { message: /expected error/ }
    );
  });
});
```

### Integration Test Template

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');

describe('Feature Integration', () => {
  let daemonProcess;

  before(async () => {
    // Start daemon
    daemonProcess = spawn('node', ['scripts/daemon/index.js']);
    await new Promise(r => setTimeout(r, 1000)); // Wait for startup
  });

  after(async () => {
    // Clean up daemon
    daemonProcess.kill();
  });

  it('should complete full workflow', async () => {
    // Test implementation
  });
});
```

### Test Best Practices

1. **Isolate tests** — Each test should be independent
2. **Mock external dependencies** — Don't hit real Telegram API in unit tests
3. **Test edge cases** — Null inputs, timeouts, errors
4. **Use descriptive names** — `should return error when token is missing`
5. **Clean up** — Reset mocks and state after each test

---

## CI/CD

Tests run automatically on:
- Pull requests to main
- Push to main branch

Tests are run across Node.js 18, 20, and 22 to ensure compatibility.

### GitHub Actions Workflow

See `.github/workflows/test.yml` for the full workflow configuration.

---

## Troubleshooting Tests

### "Cannot find module"

Ensure you're running from the plugin directory:
```bash
cd plugins/claude-afk
npm install
npm test
```

### Tests hang

- Check for unclosed connections (IPC, sockets)
- Verify mocks are properly cleaned up
- Look for missing `await` on async operations

### Flaky tests

- Add explicit waits for async operations
- Don't rely on timing—use events or polling
- Isolate tests that share state
