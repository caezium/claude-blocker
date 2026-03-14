import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { HookPayload, ClientMessage } from "./types.js";
import { DEFAULT_PORT } from "./types.js";
import { state } from "./state.js";

const LOCALHOST_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
      if (Buffer.byteLength(body, "utf-8") > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function startServer(port: number = DEFAULT_PORT): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Health check / status endpoint
    if (req.method === "GET" && url.pathname === "/status") {
      sendJson(res, state.getStatus());
      return;
    }

    // Hook endpoint - receives notifications from Claude Code
    if (req.method === "POST" && url.pathname === "/hook") {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, { error: "Forbidden" }, 403);
        return;
      }

      try {
        const body = await parseBody(req);
        const payload = JSON.parse(body) as HookPayload;

        if (!payload.session_id || !payload.hook_event_name) {
          sendJson(res, { error: "Invalid payload" }, 400);
          return;
        }

        state.handleHook(payload);
        sendJson(res, { ok: true });
      } catch (error) {
        if (error instanceof Error && error.message === "Body too large") {
          sendJson(res, { error: "Payload too large" }, 413);
          return;
        }
        sendJson(res, { error: "Invalid JSON" }, 400);
      }
      return;
    }

    // 404 for unknown routes
    sendJson(res, { error: "Not found" }, 404);
  });

  // WebSocket server for Chrome extension
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      ws.close();
      return;
    }

    console.log("Extension connected");

    // Subscribe to state changes
    const unsubscribe = state.subscribe((message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;

        if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on("close", () => {
      console.log("Extension disconnected");
      unsubscribe();
    });

    ws.on("error", () => {
      unsubscribe();
    });
  });

  server.listen(port, LOCALHOST_HOST, () => {
    console.log(`
┌─────────────────────────────────────┐
│                                     │
│   Claude Blocker Server             │
│                                     │
│   HTTP:      http://${LOCALHOST_HOST}:${port}  │
│   WebSocket: ws://${LOCALHOST_HOST}:${port}/ws │
│   Local-only: accepts loopback only │
│                                     │
│   Waiting for Claude Code hooks...  │
│                                     │
└─────────────────────────────────────┘
`);
  });

  // Graceful shutdown - use once to prevent stacking handlers
  process.once("SIGINT", () => {
    console.log("\nShutting down...");
    state.destroy();
    wss.close();
    server.close();
    process.exit(0);
  });
}
