# Contributing

Thanks for your interest in contributing to this project!

## Quick Links

Each plugin has its own detailed contributing guide:

- [claude-afk Contributing Guide](./plugins/claude-afk/docs/CONTRIBUTING.md)

## General Guidelines

### Reporting Issues

- Search existing issues first to avoid duplicates
- Use the issue templates when available
- Include reproduction steps and environment details

### Pull Requests

1. Fork the repository
2. Create a feature branch from `master`
3. Make your changes
4. Run tests: `npm test` (from within the plugin directory)
5. Submit a PR with a clear description

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/claude-plugins.git
cd claude-plugins

# Install dependencies for a plugin
cd plugins/claude-afk
npm install

# Run tests
npm test

# Test locally with Claude Code
claude --plugin-dir ./
```

## Questions?

Open an issue or start a discussion - we're happy to help!
