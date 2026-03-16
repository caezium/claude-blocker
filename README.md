# Claude Blocker

Block distracting websites unless your coding agent is actively running inference.

Supports:
- [Claude Code](https://claude.ai/claude-code) via hooks
- [T3 Code](https://github.com/pingdotgg/t3code) via websocket bridge (Codex-backed)
- Optional peer blocker servers (cross-machine aggregation)

Note: standalone Codex CLI hook mode is not in this phase. Codex support here is through T3 Code.

**The premise is simple:** if your agent is working, you should be too. When it stops, your distractions come back.

## How It Works

```
┌─────────────────┐     hooks      ┌─────────────────┐    websocket    ┌─────────────────┐
│ Claude or T3    │ ─────────────► │  Blocker Server │ ◄─────────────► │Browser Extension│
│ (Codex via T3)  │                │  (localhost)    │                 │   (browser)     │
└─────────────────┘                └─────────────────┘                 └─────────────────┘
       │                                   │                                   │
       │ UserPromptSubmit                  │ tracks sessions                   │ blocks sites
       │ PreToolUse                        │ broadcasts state                  │ shows modal
       │ Stop                              │                                   │ bypass button
       └───────────────────────────────────┴───────────────────────────────────┘
```

1. **Claude hooks or T3 events** notify the server when work starts/stops or needs input
2. **Blocker server** tracks provider sessions and their working/idle states
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

For T3-first mode (Codex in T3 app), run:

```bash
npx claude-blocker --provider t3
```

On macOS, this now auto-detects the T3 Desktop backend URL/token when available.
Use `--t3-url` to force a specific endpoint.

### 2. Install the browser extension

For Chrome/Chromium:
- Load unpacked from `packages/extension/dist` after running `pnpm --filter @claude-blocker/extension build:chrome`

For Firefox:
- Build Firefox package: `pnpm --filter @claude-blocker/extension build:firefox`
- Open `about:debugging#/runtime/this-firefox`
- Click **Load Temporary Add-on...**
- Select `packages/extension/dist-firefox/manifest.json`
- Firefox compatibility note: this build uses `background.scripts` (not `background.service_worker`) for temporary add-on support.
- Connection note: extension connects to `127.0.0.1` loopback (`ws://127.0.0.1:<port>/ws`).

### 3. Configure blocked sites

Click the extension icon → Settings to add sites you want blocked when Claude is idle.
If you run the server on a non-default port, set the same value in extension Settings → Server Port.
In Settings → Emergency Bypass, you can configure:
- Unlocks per day
- Unlock duration (minutes)

Default blocked sites: `x.com`, `youtube.com`

## Server CLI

```bash
# Configure Claude Code hooks
npx claude-blocker --setup

# Start server in auto mode (Claude hooks + T3 bridge)
npx claude-blocker

# Enable LAN mode (for cross-machine peer polling without tunnels)
npx claude-blocker --host 0.0.0.0

# T3-only mode (skip Claude hook setup prompt)
npx claude-blocker --provider t3

# Explicit provider mode
npx claude-blocker --provider claude
npx claude-blocker --provider auto

# Override T3 websocket endpoint/token
npx claude-blocker --provider t3 --t3-url ws://127.0.0.1:3773
npx claude-blocker --provider t3 --t3-token YOUR_TOKEN

# Aggregate status from another machine (repeat flag for multiple peers)
npx claude-blocker --provider t3 --peer-status-url https://studio.tailnet.ts.net/status
npx claude-blocker --peer-status-url http://192.168.1.50:8765/status --peer-refresh-ms 2000

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
- **Cross-machine support** — Include remote blocker `/status` peers in totals
- **Emergency bypass** — Configurable unlock duration and unlocks per day
- **Configurable sites** — Add/remove sites from extension settings
- **Works offline** — Blocks everything when server isn't running (safety default)

## Cross-Machine Setup (MacBook + Mac Studio)

Run blocker on each machine as usual. On the machine with the browser extension (MacBook), include the Mac Studio status URL as a peer:

```bash
npx claude-blocker --provider t3 --peer-status-url https://<mac-studio-tailnet-host>/status
```

Notes:
- Peer URLs must be reachable from the MacBook (`http://.../status` or `https://.../status`).
- For direct LAN access (no tunnel), run the remote server with `--host 0.0.0.0`.
- Do not create a loop where A polls B and B polls A, or counts can be double-included.

## Requirements

- Node.js 18+
- Chrome/Chromium or Firefox
- [Claude Code](https://claude.ai/claude-code) and/or [T3 Code](https://github.com/pingdotgg/t3code)

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

### Running From This Repo

If you are running from a local clone (not installed globally), use:

```bash
pnpm --filter claude-blocker dev -- --provider t3
# or built binary:
node packages/server/dist/bin.js --provider t3
```

## Privacy

- **No data collection** — All data stays on your machine
- **Inbound local only by default** — Server binds to `127.0.0.1`; optional outbound peer polling only hits URLs you configure
- **Browser sync** — Blocked sites list syncs via your browser account if sync storage is enabled

See [PRIVACY.md](PRIVACY.md) for full privacy policy.

## License

MIT © [Theo Browne](https://github.com/t3dotgg)
