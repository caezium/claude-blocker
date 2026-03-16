# claude-blocker

CLI tool and server for [Claude Blocker](https://github.com/t3-content/claude-blocker) — block distracting websites unless your coding agent is actively running inference.

Note: Codex support in this release is through T3 Code websocket events. Standalone Codex CLI hooks are phase 2.

## Installation

```bash
npm install -g claude-blocker
# or
npx claude-blocker
```

## Quick Start

```bash
# First time setup (configures Claude Code hooks)
npx claude-blocker --setup

# Then start the server
npx claude-blocker

# T3-only mode (Codex in T3 Code app)
npx claude-blocker --provider t3
```

## Usage

```bash
# Start server (default port 8765)
npx claude-blocker

# Bind on LAN (allows other machines to read /status)
npx claude-blocker --host 0.0.0.0

# Start T3-only mode
npx claude-blocker --provider t3

# On macOS, T3 Desktop backend is auto-detected if --t3-url is not provided

# Explicit provider mode
npx claude-blocker --provider auto
npx claude-blocker --provider claude

# Custom T3 endpoint / token
npx claude-blocker --provider t3 --t3-url ws://127.0.0.1:3773
npx claude-blocker --provider t3 --t3-token YOUR_TOKEN

# Aggregate other machine(s) into this blocker state
npx claude-blocker --peer-status-url https://studio.tailnet.ts.net/status
npx claude-blocker --peer-status-url http://192.168.1.50:8765/status --peer-refresh-ms 2000

# Configure hooks (and exit)
npx claude-blocker --setup

# Custom port
npx claude-blocker --port 9000

# Configure hooks for a custom port
npx claude-blocker --setup --port 9000

# Remove hooks from Claude Code
npx claude-blocker --remove

# Show help
npx claude-blocker --help
```

## How It Works

1. **Hooks** — The `--setup` command adds hooks to `~/.claude/settings.json` that notify the server when:
   - You submit a prompt (`UserPromptSubmit`)
   - Claude uses a tool (`PreToolUse`)
   - Claude finishes (`Stop`)
   - A session starts/ends (`SessionStart`, `SessionEnd`)

2. **T3 bridge** — In `--provider t3` or `--provider auto`, the server connects to T3 websocket and consumes `orchestration.domainEvent` updates, mapping:
   - `thread.session-set` (`running`/`starting`) => working
   - `thread.activity-appended` (`user-input.requested`/`resolved`) => waiting transitions

3. **Server** — Runs on localhost and:
   - Tracks provider sessions (`claude`, `t3`)
   - Optionally polls peer `/status` endpoints and adds their counts
   - Knows when sessions are "working" vs "idle"
   - Broadcasts state via WebSocket to the browser extension

4. **Extension** (Chrome/Firefox) — Connects to the server and:
   - Blocks configured sites when no sessions are working
   - Shows a modal overlay (soft block, not network block)
   - Supports configurable bypass unlock duration and unlocks/day
   - Updates in real-time without page refresh

## API

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Returns current state (sessions, blocked status, working, waitingForInput, providerMode, t3 connection debug, peer connection state) |
| `/hook` | POST | Receives hook payloads from Claude Code |

### WebSocket

Connect to `ws://127.0.0.1:8765/ws` to receive real-time state updates:

```json
{
  "type": "state",
  "blocked": true,
  "sessions": 1,
  "working": 0,
  "waitingForInput": 0
}
```

## Cross-Machine Aggregation

Use `--peer-status-url` on your browser machine to include remote blocker state in totals:

```bash
npx claude-blocker --provider t3 \
  --peer-status-url https://<mac-studio-tailnet-host>/status
```

Flags:
- `--host <127.0.0.1|0.0.0.0>` (default `127.0.0.1`)
- `--peer-status-url <http(s)://.../status>` (repeatable)
- `--peer-refresh-ms <milliseconds>` (default `5000`)

Notes:
- Peer polling is one-way. Avoid A->B and B->A loops to prevent double-counting.
- Remote blocker servers bind to loopback by default; use `--host 0.0.0.0` on the remote machine for direct LAN access.

## Programmatic Usage

```typescript
import { startServer } from 'claude-blocker';

// Start on default port (8765)
startServer();

// Or custom port
startServer(9000);
```

## Requirements

- Node.js 18+
- [Claude Code](https://claude.ai/claude-code) and/or [T3 Code](https://github.com/pingdotgg/t3code)

## License

MIT
