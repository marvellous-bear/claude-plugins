# Contributing

Thank you for your interest in contributing to Claude AFK! This guide will help you get started.

## Quick Start for Contributors

```bash
# Clone the repository
git clone https://github.com/marvellous-bear/claude-plugins.git
cd claude-plugins/plugins/claude-afk

# Install dependencies
npm install

# Run tests
npm test

# Test with Claude Code
claude --plugin-dir ./
```

---

## Development Setup

### Prerequisites

- Node.js 18 or higher
- Git
- A Telegram account (for manual testing)
- Claude Code installed

### Environment Setup

1. **Create a test Telegram bot:**
   - Message @BotFather in Telegram
   - Create a new bot with `/newbot`
   - Save the token

2. **Set environment variable:**
   ```bash
   export CLAUDE_AFK_TELEGRAM_TOKEN="your-test-bot-token"
   ```

3. **Install dependencies:**
   ```bash
   cd plugins/claude-afk
   npm install
   ```

4. **Verify setup:**
   ```bash
   npm test
   ```

---

## Project Structure

```
plugins/claude-afk/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── commands/                  # Slash command definitions
│   ├── enable.md
│   ├── disable.md
│   ├── setup.md
│   └── status.md
├── hooks/
│   ├── hooks.json            # Hook registration
│   └── session-start.js      # SessionStart hook
├── scripts/
│   ├── cli.js                # CLI handler for commands
│   ├── permission-handler.js # PermissionRequest hook
│   ├── stop-handler.js       # Stop hook
│   ├── session-lookup.js     # Terminal ID detection
│   └── daemon/               # Background daemon
│       ├── index.js          # Entry point
│       ├── singleton.js      # File locking
│       ├── ipc.js            # Named pipe server
│       ├── sessions.js       # Session registry
│       ├── telegram.js       # Telegram API
│       └── transcript.js     # Transcript parsing
├── tests/
│   ├── integration/          # Integration tests
│   └── fixtures/             # Test data
├── docs/                     # Documentation
├── package.json
└── README.md
```

---

## Making Changes

### Workflow

1. **Fork and clone** the repository
2. **Create a branch** for your change: `git checkout -b feature/my-feature`
3. **Make your changes** with tests
4. **Run tests:** `npm test`
5. **Test manually** with Claude Code if applicable
6. **Commit** with a descriptive message
7. **Push** and create a pull request

### Commit Messages

Use clear, descriptive commit messages:

```
Add bulk approval for Write tool

- Extend whitelist functionality to Write operations
- Add tests for new behavior
- Update documentation
```

### Pull Request Guidelines

- **Describe the change** — What does it do? Why is it needed?
- **Include tests** — New features need tests
- **Update docs** — If user-facing behavior changes
- **Keep it focused** — One feature/fix per PR

---

## Testing Your Changes

### Unit Tests

Run unit tests after any code change:

```bash
npm test
```

### Manual Testing

For changes to user-facing features:

1. Start Claude Code with the plugin:
   ```bash
   claude --plugin-dir ./
   ```

2. Run through the [manual test checklist](./TESTING.md#manual-testing)

### Integration Tests

For changes to multi-component interactions:

```bash
npm run test:integration
```

---

## Code Style

### JavaScript

- Use `const` and `let`, never `var`
- Use async/await for promises
- Handle errors gracefully (especially in hooks)
- Add JSDoc comments for public functions

### Example

```javascript
/**
 * Sends a permission request to Telegram.
 * @param {string} sessionId - The session identifier
 * @param {Object} request - The permission request details
 * @returns {Promise<string>} The user's response ('yes', 'no', or 'all')
 */
async function sendPermissionRequest(sessionId, request) {
  try {
    const message = formatMessage(request);
    const messageId = await telegram.sendMessage(message);
    return await waitForResponse(messageId);
  } catch (error) {
    console.error('Permission request failed:', error);
    return null; // Fail-open: let Claude prompt locally
  }
}
```

### Hooks

Hooks have special requirements:

1. **Never throw** — Always catch errors and return gracefully
2. **Fail-open** — On errors, return nothing (passthrough)
3. **Log errors** — Write to `~/.claude/claude-afk/logs/hook.log`
4. **Respect timeouts** — Don't block Claude indefinitely

---

## Architecture Decisions

When making significant changes, consider:

1. **Fail-open principle** — Never block Claude due to plugin errors
2. **Multi-session support** — Changes should work with concurrent terminals
3. **Platform compatibility** — Test on Windows, macOS, and Linux
4. **State isolation** — Don't leak state between sessions

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design documentation.

---

## Areas for Contribution

### Good First Issues

- Improve error messages
- Add more test coverage
- Fix documentation typos
- Add examples to docs

### Feature Ideas

- Support for other notification platforms (Slack, Discord)
- Web dashboard for session monitoring
- Customizable notification templates
- Rate limiting for bulk operations

### Known Issues

- Orphaned processes on Windows need manual cleanup
- TTY detection unreliable in some Linux environments
- No retry logic for Telegram API failures

---

## Getting Help

- **Questions:** Open a GitHub issue with the "question" label
- **Bugs:** Open a GitHub issue with reproduction steps
- **Ideas:** Open a GitHub issue with the "enhancement" label

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
