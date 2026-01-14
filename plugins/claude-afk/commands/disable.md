---
allowed-tools: Bash
---

# Disable AFK Mode

Disable AFK (Away From Keyboard) mode for the current Claude Code session. Permission requests will be handled locally instead of via Telegram.

## Instructions

Run the following command to disable AFK mode:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" disable
```

Report the output to the user. If successful, inform them that:
- Permission requests will now be handled locally
- They can re-enable AFK mode anytime with /claude-afk:enable

If there's an error, explain what went wrong based on the error message.
