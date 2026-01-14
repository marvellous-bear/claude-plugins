# Architecture

This document provides a detailed technical overview of Claude AFK's architecture, components, and design decisions.

## Overview

Claude AFK consists of three main layers:

1. **Hooks** — Claude Code event interceptors (runs in Claude's process)
2. **Daemon** — Singleton background process (manages state and Telegram)
3. **Telegram API** — External communication channel

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Process                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │SessionStart │  │ Permission  │  │    Stop     │                  │
│  │   Hook      │  │   Hook      │  │    Hook     │                  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                  │
└─────────┼────────────────┼────────────────┼─────────────────────────┘
          │                │                │
          │    IPC (Named Pipes, NDJSON)    │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Daemon Process                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │  Singleton  │  │   Session   │  │     IPC     │  │  Telegram  │ │
│  │    Lock     │  │  Registry   │  │   Server    │  │   Poller   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────┬──────┘ │
└───────────────────────────────────────────────────────────┼────────┘
                                                            │
                                                            ▼
                                                  ┌─────────────────┐
                                                  │  Telegram API   │
                                                  │   (getUpdates)  │
                                                  └─────────────────┘
```

---

## Hooks

Hooks are Claude Code's extension mechanism. Claude AFK uses three hooks:

### SessionStart Hook

**File:** `hooks/session-start.js`

**Purpose:** Map terminal IDs to session IDs for concurrent session support.

**Flow:**
1. Fires when a Claude Code session starts
2. Detects terminal ID using platform-specific methods
3. Sends mapping to daemon via IPC
4. Returns quickly (non-blocking)

**Terminal ID Detection Priority:**
1. **Windows Terminal:** `WT_SESSION` environment variable
2. **macOS Terminal:** `TERM_SESSION_ID` environment variable
3. **iTerm2:** `ITERM_SESSION_ID` environment variable
4. **Linux TTY:** Parse from `/proc/self/stat` or `ps` command
5. **Fallback:** Process ID (unreliable for concurrent sessions)

### PermissionRequest Hook

**File:** `scripts/permission-handler.js`

**Purpose:** Intercept permission requests and route to Telegram.

**Flow:**
1. Claude requests permission for a tool (Bash, Edit, Write, etc.)
2. Hook connects to daemon via IPC
3. Daemon sends Telegram notification with context
4. Hook waits for response (up to 5 minutes)
5. Returns allow/deny decision to Claude

**Response Format (Allow):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

**Response Format (Deny):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Denied via Telegram",
      "interrupt": true
    }
  }
}
```

**Fail-Open Behavior:**
- If daemon unavailable → Return nothing (Claude shows normal prompt)
- If IPC timeout → Return nothing
- Only explicit "no" from user → Deny

### Stop Hook

**File:** `scripts/stop-handler.js`

**Purpose:** Intercept task completion and enable follow-up instructions.

**Flow:**
1. Claude finishes a task and tries to stop
2. Hook connects to daemon via IPC
3. Daemon sends "task complete" notification to Telegram
4. Hook waits for follow-up (default: 60 seconds)
5. If follow-up received → Inject as next prompt
6. If timeout → Allow stop

**Response Format (Inject Follow-up):**
```json
{
  "decision": "block",
  "reason": "User's follow-up instructions go here"
}
```

The `reason` field becomes Claude's next user input.

---

## Daemon

The daemon is a singleton Node.js process that coordinates all sessions.

### Singleton Lock

**File:** `scripts/daemon/singleton.js`

**Mechanism:**
- File lock at `~/.claude/claude-afk/daemon.lock`
- Uses `proper-lockfile` npm package
- Heartbeat every 15 seconds
- Stale lock detection (60 second timeout)

**Why singleton?**
- Only one process can poll Telegram's `getUpdates`
- Centralizes state management
- Reduces API calls

### Session Registry

**File:** `scripts/daemon/sessions.js`

**Data Structure:**
```javascript
{
  sessions: {
    "session-abc123": {
      terminalId: "wt-session-456",
      token: "myproject-a3f8",
      enabled: true,
      createdAt: 1234567890
    }
  },
  terminalToSession: {
    "wt-session-456": "session-abc123"
  }
}
```

**Session Token Format:** `{projectSlug}-{4-char-hex}` (e.g., `api-server-a3f8`)

### IPC Server

**File:** `scripts/daemon/ipc.js`

**Protocol:**
- **Windows:** Named pipe `\\.\pipe\claude-afk`
- **Unix:** Unix socket `/tmp/claude-afk.sock`
- **Format:** NDJSON (newline-delimited JSON)
- **Correlation:** Each request has a `request_id` (UUID)

**Message Types:**
- `register_session` — Map terminal to session
- `permission_request` — Request permission approval
- `stop_notification` — Notify task completion
- `get_status` — Query daemon status

### Telegram Poller

**File:** `scripts/daemon/telegram.js`

**Mechanism:**
- Long-polling via `getUpdates` API
- Poll interval: 2 seconds
- Long-poll timeout: 30 seconds
- Stale message filtering: Ignores messages > 5 minutes old

**Conflict Prevention:**
```javascript
if (isPolling) return; // Guard against overlapping requests
isPolling = true;
try {
  const updates = await getUpdates(offset);
  // Process updates...
} finally {
  isPolling = false;
}
```

---

## State Storage

All state is stored in `~/.claude/claude-afk/`:

| File | Purpose |
|------|---------|
| `state.json` | Chat ID, active sessions, pending requests |
| `config.json` | User configuration |
| `daemon.lock` | Singleton lock file |
| `logs/hook.log` | Error logs from hooks |

### state.json Structure

```json
{
  "chatId": 123456789,
  "sessions": {
    "session-abc": {
      "token": "myproject-a3f8",
      "enabled": true
    }
  },
  "pendingRequests": {
    "req-uuid-1": {
      "sessionId": "session-abc",
      "messageId": 42,
      "type": "permission",
      "tool": "Bash"
    }
  },
  "sessionWhitelists": {
    "session-abc": ["Edit", "Write"]
  }
}
```

---

## Bulk Approval

The `all` response enables bulk approval for repetitive permissions.

**How it works:**
1. User replies `all` to a permission request
2. Tool type (e.g., `Edit`) is added to session whitelist
3. Future requests for that tool auto-approve without Telegram notification
4. Whitelist clears when session disables AFK mode

**Configurable tools:** Only tools in `bulkApprovalTools` config support `all`.

---

## Error Handling

### Hook Errors

- Hooks should never crash Claude
- All errors → Log and return passthrough
- IPC timeouts → Passthrough (let Claude prompt locally)

### Daemon Errors

- Telegram API errors → Log and continue polling
- IPC errors → Close connection, continue serving others
- State file corruption → Reset to defaults

### Cleanup

**Orphaned hook processes:**
- Permission hooks can be orphaned if user approves locally
- Hooks use IPC timeout (5 minutes) to eventually terminate
- Cleanup script available: `scripts/cleanup.ps1`

**Orphaned Telegram messages:**
- When local approval happens, daemon deletes the Telegram notification
- Tracks socket → messageId mapping for cleanup

---

## Platform Considerations

### Windows

- Named pipes: `\\.\pipe\claude-afk`
- Environment variables: Require terminal restart after setting
- Process termination: May leave orphaned processes

### macOS/Linux

- Unix sockets: `/tmp/claude-afk.sock`
- Socket permissions: May need adjustment
- TTY detection: More reliable than Windows

---

## Future Considerations

### Not Implemented

- **Multi-user support** — Would require separate bots per user
- **Alternative platforms** — Slack, Discord, SMS
- **Web dashboard** — Real-time session monitoring
- **Subagent detection** — Currently treats subagent permissions same as main thread

### Known Limitations

- Single Telegram chat per installation
- Requires reply feature for message routing
- 5-minute permission timeout is hardcoded
- No retry logic for Telegram API failures
