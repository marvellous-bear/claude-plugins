# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

This is a Claude Code plugin marketplace. Plugins live in the `plugins/` directory.

### Current Plugins

| Plugin | Description | Location |
|--------|-------------|----------|
| claude-afk | Remote notifications via Telegram | `plugins/claude-afk/` |

## Development Commands

Run from within a plugin directory (e.g., `plugins/claude-afk/`):

```bash
npm test                    # Unit tests
npm run test:watch          # Watch mode
npm run test:integration    # Integration tests only
npm run test:all            # All tests
npm run test:coverage       # Coverage (experimental)
```

Local development with Claude Code:
```bash
cd plugins/claude-afk
npm install
claude --plugin-dir ./
```

## Architecture

```
Claude Code Sessions (Multiple)
         ↓ Named Pipe IPC (NDJSON)
    Singleton Daemon (File-locked)
         ↓ Telegram API (Long-polling)
    User's Phone
```

### Core Components

**Daemon** (`scripts/daemon/index.js`) - Singleton process managing:
- Session registry (session_id ↔ short token)
- Telegram polling (2s interval, 30s timeout)
- Named pipe server for hook communication
- File locking with heartbeat (60s stale timeout, 15s updates)

**Hooks** (`hooks/hooks.json`) - Three Claude Code hooks:
- `SessionStart` - Maps terminal_id → session_id for concurrent session support
- `PermissionRequest` - Intercepts permissions, routes to daemon for Telegram approval (5 min timeout)
- `Stop` - Intercepts task completion, notifies via Telegram, waits for follow-up instructions (90s timeout)

**CLI** (`scripts/cli.js`) - User commands: setup, enable, disable, status

### IPC Protocol

Named pipe paths:
- Windows: `\\.\pipe\claude-afk`
- Unix: `/tmp/claude-afk.sock`

Protocol: NDJSON with `request_id` (UUID) for correlation.

### Terminal ID Detection Priority

1. Windows Terminal: `WT_SESSION` env var
2. macOS: `TERM_SESSION_ID` or `ITERM_SESSION_ID`
3. Linux: Controlling TTY via `ps` or `/proc/self/stat`
4. Fallback: PID-based (unreliable for concurrent sessions)

### State Storage

`~/.claude/claude-afk/`:
- `state.json` - Chat ID, AFK sessions, pending requests, session whitelists
- `config.json` - User configuration
- `daemon.lock` - Singleton lock file
- `logs/hook.log` - Hook error logs

### Bulk Approval

Users can respond with "all" to approve all future requests of that tool type for the session.

**Config** (`config.json`):
```json
{
  "bulkApprovalTools": ["Edit", "Write", "Glob"]  // default - tools that support "all"
}
```

**State** (`state.json`):
```json
{
  "sessionWhitelists": {
    "session-abc": ["Edit", "Write"]  // per-session whitelists
  }
}
```

- Notification shows `Reply: yes / no / all` only for tools in `bulkApprovalTools`
- Whitelisted tools auto-approve without Telegram notification
- Whitelist clears when session disables AFK

## Key Patterns

### Fail-Open Design
Hooks should never block normal Claude operation:
- Daemon unavailable → passthrough (normal Claude prompt)
- IPC timeout → passthrough
- Only explicit "no" from user should deny

### Hook Response Formats

**PermissionRequest** (allow):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

**PermissionRequest** (deny):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "deny", "message": "reason", "interrupt": true }
  }
}
```

**Stop** (block and inject prompt):
```json
{
  "decision": "block",
  "reason": "Text becomes Claude's next input"
}
```

### Session Token Format
`{projectSlug}-{4-char-hex}` (e.g., `my-app-a3f8`)

## Testing

- Uses Node.js native test runner (`node --test`)
- No external test frameworks
- Unit tests mock IPC clients
- Integration tests spawn real daemon processes

See `plugins/claude-afk/docs/TESTING.md` for detailed testing guide.

## Documentation

Each plugin has its own documentation in `plugins/{plugin}/docs/`:
- `README.md` - User guide and quick start
- `docs/ARCHITECTURE.md` - Technical architecture
- `docs/TESTING.md` - Testing guide
- `docs/CONTRIBUTING.md` - Contribution guidelines
