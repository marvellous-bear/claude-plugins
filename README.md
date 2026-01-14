# Claude Plugins

A marketplace of plugins for Claude Code by [marvellous-bear](https://github.com/marvellous-bear).

## Available Plugins

| Plugin | Description |
|--------|-------------|
| **[claude-afk](./plugins/claude-afk)** | Go AFK while Claude keeps working. Route permission requests and task notifications to Telegram. |

---

## Installation

### 1. Add this marketplace

```
/plugin marketplace add marvellous-bear/claude-plugins
```

### 2. Install a plugin

```
/plugin install claude-afk@marvellous-bear/claude-plugins
```

Or browse available plugins with `/plugin` → Discover.

---

## Plugins

### claude-afk

**Go AFK. Stay productive.** Route Claude Code permission requests and task notifications to your phone via Telegram.

**Key features:**
- Permission requests → Telegram → Reply `yes`/`no`/`all`
- Task completions → Telegram → Reply with follow-up instructions
- Multiple concurrent sessions supported
- Fail-open design (never blocks Claude)

**[Full documentation →](./plugins/claude-afk)**

---

## Contributing

We welcome contributions! See individual plugin directories for contribution guidelines.

### Adding a new plugin

1. Create `plugins/your-plugin/` directory
2. Add `.claude-plugin/plugin.json` manifest
3. Add your commands, hooks, scripts, etc.
4. Update `.claude-plugin/marketplace.json` at the root
5. Submit a pull request

### Plugin structure

```
plugins/your-plugin/
├── .claude-plugin/
│   └── plugin.json       # Required: Plugin manifest
├── commands/             # Optional: Slash commands
├── hooks/                # Optional: Event hooks
├── scripts/              # Optional: Runtime scripts
├── tests/                # Recommended: Tests
├── docs/                 # Recommended: Documentation
├── package.json          # If using npm dependencies
├── README.md             # Required: Documentation
└── LICENSE               # Required: License
```

---

## License

Each plugin has its own license. See individual plugin directories.
