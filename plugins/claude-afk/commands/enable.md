---
allowed-tools: Bash
---

# Enable AFK Mode

Enable AFK (Away From Keyboard) mode for the current Claude Code session. When enabled, you will receive Telegram notifications for permission requests and task completions.

## Instructions

Run the following command to enable AFK mode:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" enable
```

Report the output to the user. If successful, inform them that:
- They will receive Telegram notifications when Claude needs permission approvals
- They can reply "yes" or "no" directly to notification messages
- They can disable AFK mode anytime with /claude-afk:disable

If there's an error about no session found, explain that this command must be run from within a Claude Code session.

If there's an error about the daemon not running, suggest running /claude-afk:setup first.
