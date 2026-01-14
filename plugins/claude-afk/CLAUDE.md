# CLAUDE.md - Claude AFK Plugin

This file provides guidance to Claude Code when working with the claude-afk plugin.

## Quick Reference

```bash
# Development
npm install                     # Install dependencies
npm test                        # Run unit tests (11 test files)
npm run test:integration        # Integration tests
npm run test:all                # All tests
npm run test:watch              # Watch mode

# Local testing with Claude Code
claude --plugin-dir ./
```

## Project Overview

Claude AFK enables remote Telegram notifications and approvals for Claude Code sessions. Users can approve/deny permission requests and provide follow-up instructions from their phone while away from their computer.

**Key Files:**
- `scripts/daemon/index.js` - Main daemon process (singleton)
- `scripts/cli.js` - CLI command handler (enable/disable/status/setup)
- `scripts/permission-handler.js` - PermissionRequest hook handler
- `scripts/stop-handler.js` - Stop hook handler
- `hooks/session-start.js` - SessionStart hook (terminal ID mapping)
- `hooks/hooks.json` - Hook configuration

## Architecture

```
Claude Code Session(s)
        ↓ Named Pipe IPC (NDJSON)
   Singleton Daemon (file-locked)
        ↓ HTTP API
   Telegram Bot API
        ↓
   User's Phone
```

### Three-Layer Design

1. **Hooks** - Run in Claude's process, intercept events, communicate via IPC
2. **Daemon** - Background singleton managing state, IPC server, Telegram polling
3. **Telegram** - Long-polling bot API for remote user interaction

## Hook System

### Hook Configuration (`hooks/hooks.json`)

```json
{
  "hooks": {
    "SessionStart": [{ "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js" }],
    "PermissionRequest": [{ "matcher": "*", "command": "...", "timeout": 3600 }],
    "Stop": [{ "command": "...", "timeout": 3600 }]
  }
}
```

### Hook Response Formats

**PermissionRequest - Allow:**
```javascript
{
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' }
  }
}
```

**PermissionRequest - Deny:**
```javascript
{
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'reason', interrupt: true }
  }
}
```

**Stop - Block with follow-up:**
```javascript
{
  decision: 'block',
  reason: 'User instructions become Claude\'s next input'
}
```

**Stop - Allow stop:**
```javascript
{}  // Empty object allows normal stop
```

### Hook Behavior Summary

| Hook | Purpose | Passthrough Condition |
|------|---------|----------------------|
| SessionStart | Map terminal→session | Always (returns null) |
| PermissionRequest | Remote approval | Daemon unavailable, not enabled, timeout |
| Stop | Wait for follow-up | Daemon unavailable, not enabled, timeout |

## Daemon Implementation

### Core Components (`scripts/daemon/`)

| File | Purpose |
|------|---------|
| `index.js` | Main daemon, request routing, Telegram polling |
| `ipc.js` | Named pipe server/client (NDJSON protocol) |
| `sessions.js` | Session registry, token generation |
| `singleton.js` | File lock management (proper-lockfile) |
| `telegram.js` | Telegram Bot API client |
| `transcript.js` | Transcript parsing (Safe Mode) |

### Configuration (`~/.claude/claude-afk/config.json`)

```javascript
{
  alwaysEnabled: false,           // Skip enable/disable, always route to Telegram
  retryInterval: 300,             // 5 min between retries
  maxRetries: 3,                  // Max retries before giving up
  permissionTimeout: 3600,        // 1 hour
  stopFollowupTimeout: 3600,      // 1 hour
  staleUpdateThreshold: 300,      // 5 min - ignore old Telegram updates
  pollingInterval: 2,             // 2 sec Telegram poll interval
  allowSinglePendingFallback: true,  // Route non-replies to single pending
  bulkApprovalTools: ['Edit', 'Write'],  // Tools supporting "all" response
  transcriptPolling: {
    enabled: true,
    intervalMs: 3000,
    enableMtimeOptimization: true
  }
}
```

### State Management (`~/.claude/claude-afk/state.json`)

```javascript
{
  chatId: number,                 // Telegram chat ID (set via /start)
  afkSessions: string[],          // Session IDs with AFK enabled
  pendingRequests: {              // Dual-indexed by messageId
    "12345": {
      sessionId, tool, command, tool_use_id,
      requestType: 'permission' | 'stop',
      transcriptPath, projectDir, terminalId,
      lastCheckedOffset, firstRequestAt, requestId,
      retryCount, socketAlive
    }
  },
  requestsBySession: {            // Secondary index for fast lookup
    "session-abc": ["12345", "12346"]
  },
  sessionWhitelists: {            // Bulk approval tracking
    "session-abc": ["Edit", "Write"]
  }
}
```

### IPC Protocol

**Pipe paths:**
- Windows: `\\.\pipe\claude-afk`
- Unix: `/tmp/claude-afk.sock`

**Message format (NDJSON):**
```javascript
{
  type: 'permission_request' | 'stop_request' | 'enable_afk' | 'disable_afk' | 'status',
  request_id: 'uuid',  // For response correlation
  session_id: '...',
  // ... type-specific fields
}
```

### Key Daemon Functions

**Request Handling:**
- `handlePermissionRequest()` - Send notification, wait for reply
- `handleStopRequest()` - Send completion notification, wait for follow-up
- `handleEnableAfk()` / `handleDisableAfk()` - Toggle AFK for session
- `handleStatus()` - Return daemon status

**Telegram Processing:**
- `processTelegramUpdates()` - Poll and route updates
- `processUpdate()` - Handle /start, route replies
- `handleResponse()` - Parse yes/no/all, respond to hooks

**Local Resolution Detection:**
- `pollTranscripts()` - Check for local approvals
- `checkPermissionResolution()` - Find tool_result in transcript
- `checkStopResolution()` - Find new user message
- `handleLocalResolution()` - Clean up, delete Telegram message

## Terminal ID Detection

**Priority order** (`scripts/session-lookup.js`):

1. Windows Terminal: `WT_SESSION` env var
2. macOS Terminal: `TERM_SESSION_ID` env var
3. iTerm2: `ITERM_SESSION_ID` env var
4. Linux TTY: `ps -o tty=` or `/proc/self/stat`
5. X11: `WINDOWID` env var
6. Fallback: Process PID (unreliable for concurrent sessions)

**Session file:** `~/.claude/sessions/by-terminal/{terminal_id}.json`

## Transcript Parsing

**Important:** Transcript format is Claude Code internal - may change without notice.

**Safe Mode Design:**
- All functions return `null` on error (never throw)
- Malformed lines skipped silently
- Missing files don't crash daemon

**Key Functions (`scripts/daemon/transcript.js`):**

| Function | Purpose |
|----------|---------|
| `getLastClaudeMessage()` | Get assistant context for notification |
| `getLastUserMessage()` | Fallback context |
| `getLastToolUse()` | Get tool_use awaiting permission |
| `findToolResult()` | Detect permission resolution |
| `findUserMessage()` | Detect stop resolution |
| `findSubagentTranscripts()` | Check agent-*.jsonl files |
| `formatToolInput()` | Format tool params for display |

## Design Principles

### Fail-Open

Hooks should NEVER block normal Claude operation:
- Daemon unavailable → passthrough (normal Claude prompt)
- IPC timeout → passthrough
- Transcript error → log and continue
- Only explicit "no" from user → deny

### Dual-Index Structure

Pending requests indexed by both:
- `messageId` (string) - for Telegram reply routing
- `sessionId` - for session-based cleanup and retry detection

### Bulk Approval

Users can respond "all" to auto-approve future requests of that tool type:
- Only for tools in `bulkApprovalTools` config
- Per-session whitelist (clears on disable)
- Notification shows "Reply: yes / no / all" for eligible tools

### Retry Handling

When hook times out and retries:
1. Daemon detects matching (sessionId, tool, command)
2. Increments `retryCount`
3. After `maxRetries` → delete notification, respond `timeout_final`

### Socket Disconnect Cleanup

When Claude Code process closes (local approval):
1. Daemon detects socket close
2. Deletes Telegram notification
3. Removes from state

## Testing

**Framework:** Node.js built-in test runner (`node --test`)

**Test Files:**
```
scripts/cli.test.js
scripts/permission-handler.test.js
scripts/stop-handler.test.js
scripts/daemon/index.test.js
scripts/daemon/ipc.test.js
scripts/daemon/sessions.test.js
scripts/daemon/singleton.test.js
scripts/daemon/telegram.test.js
scripts/daemon/transcript.test.js
hooks/session-start.test.js
tests/integration/full-flow.test.js
tests/integration/multi-session.test.js
tests/integration/transcript-detection.test.js
```

**Test Patterns:**
- Mock dependencies with `mock.fn()`
- Async/await with proper cleanup
- Fixtures in `tests/fixtures/`

## CLI Commands

| Command | Purpose |
|---------|---------|
| `/claude-afk:setup` | Create bot, set token, pair with chat |
| `/claude-afk:enable` | Enable AFK mode for session |
| `/claude-afk:disable` | Disable AFK mode for session |
| `/claude-afk:status` | Show daemon/config/session status |

## Debugging

**Enable debug mode:**
```bash
CLAUDE_AFK_DEBUG=1 claude
```

**Log files:**
- `~/.claude/claude-afk/logs/hook.log` - Hook errors
- `~/.claude/claude-afk/logs/hook-timing.log` - Hook timing (debug mode)

**Payload capture (debug):**
- `~/.claude/claude-afk/captures/` - Raw hook payloads

## Common Issues

### Daemon won't start
- Check lock file: `~/.claude/claude-afk/daemon.lock`
- Lock considered stale after 60s with 15s heartbeat
- Delete lock file if daemon crashed

### Terminal ID unreliable
- PID-based fallback doesn't support concurrent sessions
- Check `terminalIdSource` in session file
- Recommend using Windows Terminal, iTerm2, or native Terminal.app

### Telegram conflicts
- 3+ consecutive conflict errors → daemon shuts down
- Only one daemon should poll per bot token
- Check for daemons on other machines

### Socket cleanup not working (Windows)
- Windows doesn't fire socket close events reliably
- Transcript polling detects dead sockets via `socket.destroyed`
- Polling interval: 3 seconds

## Dependencies

```json
{
  "proper-lockfile": "^4.1.2",  // Cross-platform file locking
  "xpipe": "^1.0.5"              // Cross-platform named pipes
}
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_AFK_TELEGRAM_TOKEN` | Telegram Bot API token |
| `CLAUDE_AFK_DEBUG` | Enable debug logging (1 to enable) |
| `CLAUDE_PLUGIN_ROOT` | Set by Claude Code - plugin directory |

## File Locations

| Path | Purpose |
|------|---------|
| `~/.claude/claude-afk/config.json` | User configuration |
| `~/.claude/claude-afk/state.json` | Persistent state |
| `~/.claude/claude-afk/daemon.lock` | Singleton lock |
| `~/.claude/claude-afk/logs/` | Log files |
| `~/.claude/sessions/by-terminal/` | Terminal→session mappings |

## Key Code Patterns

### Creating IPC Client
```javascript
const { createIPCClient, getDefaultPipePath } = require('./daemon/ipc');
const client = createIPCClient(getDefaultPipePath());
const response = await client.sendAndWait({ type: 'status', request_id: uuid() });
await client.close();
```

### Parsing Transcript (Safe Mode)
```javascript
const { getLastClaudeMessage, findToolResult } = require('./daemon/transcript');
const context = await getLastClaudeMessage(transcriptPath, { maxLength: 500 });
// Returns null on any error - never throws
```

### Hook Output Format
```javascript
// Permission allowed
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' }
  }
}));

// Permission denied
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'User denied', interrupt: true }
  }
}));
```

## When Modifying This Plugin

1. **Adding new tools to bulk approval** - Update `DEFAULT_CONFIG.bulkApprovalTools`
2. **Changing timeouts** - Update both config defaults AND `hooks.json` timeout
3. **Adding IPC message types** - Handle in `handleRequest()` switch statement
4. **Modifying transcript parsing** - Maintain Safe Mode (never throw)
5. **Adding state fields** - Ensure backwards compatibility with existing state.json
