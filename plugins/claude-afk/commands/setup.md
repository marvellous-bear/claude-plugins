---
allowed-tools: Bash
---

# Claude AFK Setup

Set up Claude AFK with Telegram integration.

## Instructions

**IMPORTANT: Tell the user what to do BEFORE running the command, because the command may wait up to 60 seconds and the user won't see any output during that time.**

### Step 1: Inform the User

Tell the user:
> "I'm going to check your Claude AFK setup. **If your Telegram bot isn't paired yet, send `/start` to your bot NOW** - the setup will wait up to 60 seconds to detect the pairing."

### Step 2: Run the Setup Command

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" setup
```

### Step 3: Interpret the Output and Report to User

**Output contains "CLAUDE_AFK_TELEGRAM_TOKEN":** Token not configured. Tell the user:
1. Open Telegram and search for @BotFather
2. Send `/newbot` and follow the prompts to create a bot
3. Copy the bot token (looks like `123456:ABC-DEF...`)
4. Set environment variable: `export CLAUDE_AFK_TELEGRAM_TOKEN="your-token"`
5. Run `/claude-afk:setup` again

**Output contains "Telegram paired successfully" or "fully configured":** Success! Tell the user they can now use `/claude-afk:enable` to activate AFK mode for this session.

**Output contains "timed out":** Pairing failed. Ask the user:
- Did you send `/start` to the correct Telegram bot?
- Try running `/claude-afk:setup` again after sending `/start`
