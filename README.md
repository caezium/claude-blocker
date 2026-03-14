# Claude Blocker

Block distracting websites unless [Claude Code](https://claude.ai/claude-code) is actively running inference.

**The premise is simple:** if Claude is working, you should be too. When Claude stops, your distractions come back.

## How It Works

```
┌─────────────────┐     hooks      ┌─────────────────┐    websocket    ┌─────────────────┐
│   Claude Code   │ ─────────────► │  Blocker Server │ ◄─────────────► │Browser Extension│
│   (terminal)    │                │  (localhost)    │                 │   (browser)     │
└─────────────────┘                └─────────────────┘                 └─────────────────┘
       │                                   │                                   │
       │ UserPromptSubmit                  │ tracks sessions                   │ blocks sites
       │ PreToolUse                        │ broadcasts state                  │ shows modal
       │ Stop                              │                                   │ bypass button
       └───────────────────────────────────┴───────────────────────────────────┘
```

1. **Claude Code hooks** notify the server when you submit a prompt or when Claude finishes
2. **Blocker server** tracks all Claude Code sessions and their working/idle states
3. **Browser extension** blocks configured sites when no session is actively working

## Quick Start

### 1. Install the server

```bash
npx claude-blocker --setup
```

This installs the Claude Code hooks in `~/.claude/settings.json`.
Then start the server:

```bash
npx claude-blocker
```

### 2. Install the browser extension

For Chrome/Chromium:
- Load unpacked from `packages/extension/dist` after running `pnpm --filter @claude-blocker/extension build:chrome`

For Firefox:
- Build Firefox package: `pnpm --filter @claude-blocker/extension build:firefox`
- Open `about:debugging#/runtime/this-firefox`
- Click **Load Temporary Add-on...**
- Select `packages/extension/dist-firefox/manifest.json`

### 3. Configure blocked sites

Click the extension icon → Settings to add sites you want blocked when Claude is idle.
If you run the server on a non-default port, set the same value in extension Settings → Server Port.

Default blocked sites: `x.com`, `youtube.com`

## Server CLI

```bash
# Configure Claude Code hooks
npx claude-blocker --setup

# Start server (prompts for setup if needed)
npx claude-blocker

# Start on custom port
npx claude-blocker --port 9000

# Configure hooks for a custom port
npx claude-blocker --setup --port 9000

# Remove hooks from Claude Code settings
npx claude-blocker --remove

# Show help
npx claude-blocker --help
```

## Features

- **Soft blocking** — Sites show a modal overlay, not a hard block
- **Real-time updates** — No page refresh needed when state changes
- **Multi-session support** — Tracks multiple Claude Code instances
- **Emergency bypass** — 5-minute bypass, once per day
- **Configurable sites** — Add/remove sites from extension settings
- **Works offline** — Blocks everything when server isn't running (safety default)

## Requirements

- Node.js 18+
- Chrome/Chromium or Firefox
- [Claude Code](https://claude.ai/claude-code)

## Development

```bash
# Clone and install
git clone https://github.com/t3-content/claude-blocker.git
cd claude-blocker
pnpm install

# Build everything
pnpm build

# Development mode
pnpm dev
```

### Project Structure

```
packages/
├── server/      # Node.js server + CLI (published to npm)
├── extension/   # Browser extension (Chrome + Firefox, Manifest V3)
└── shared/      # Shared TypeScript types
```

## Privacy

- **No data collection** — All data stays on your machine
- **Local only** — Server runs on localhost, no external connections
- **Browser sync** — Blocked sites list syncs via your browser account if sync storage is enabled

See [PRIVACY.md](PRIVACY.md) for full privacy policy.

## License

MIT © [Theo Browne](https://github.com/t3dotgg)
