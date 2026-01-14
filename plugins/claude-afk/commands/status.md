---
allowed-tools: Bash
---

# Claude AFK Status

Show the current status of the Claude AFK daemon, including Telegram configuration, active AFK sessions, and pending requests.

## Instructions

Run the following command to check status:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" status
```

Report the status information to the user in a clear format. Key information includes:
- Whether the daemon is running
- Whether Telegram is configured and paired
- Number of active AFK sessions
- Number of pending permission requests
- Whether the current session has AFK mode enabled

If the daemon is not running, suggest running /claude-afk:setup to configure it.
