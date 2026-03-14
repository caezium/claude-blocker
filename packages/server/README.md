# claude-blocker

CLI tool and server for [Claude Blocker](https://github.com/t3-content/claude-blocker) — block distracting websites unless Claude Code is actively running inference.

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
```

## Usage

```bash
# Start server (default port 8765)
npx claude-blocker

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

2. **Server** — Runs on localhost and:
   - Tracks all active Claude Code sessions
   - Knows when sessions are "working" vs "idle"
   - Broadcasts state via WebSocket to the browser extension

3. **Extension** (Chrome/Firefox) — Connects to the server and:
   - Blocks configured sites when no sessions are working
   - Shows a modal overlay (soft block, not network block)
   - Updates in real-time without page refresh

## API

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Returns current state (sessions, blocked status, working, waitingForInput) |
| `/hook` | POST | Receives hook payloads from Claude Code |

### WebSocket

Connect to `ws://localhost:8765/ws` to receive real-time state updates:

```json
{
  "type": "state",
  "blocked": true,
  "sessions": 1,
  "working": 0,
  "waitingForInput": 0
}
```

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
- [Claude Code](https://claude.ai/claude-code)

## License

MIT
