import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, HookPayload, StartServerOptions } from "./types.js";
import { DEFAULT_PEER_REFRESH_MS, DEFAULT_PORT, DEFAULT_T3_WS_URL } from "./types.js";
import { state } from "./state.js";
import { T3Adapter } from "./adapters/t3Adapter.js";
import { PeerStatusPoller } from "./adapters/peerStatusPoller.js";

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

function redactToken(urlString: string): string {
  const parsed = new URL(urlString);
  if (parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", "***");
  }
  return parsed.toString();
}

export function startServer(
  port: number = DEFAULT_PORT,
  options: StartServerOptions = {
    provider: "auto",
    t3Url: DEFAULT_T3_WS_URL,
  }
): void {
  state.setProviderMode(options.provider);
  const t3Enabled = options.provider === "auto" || options.provider === "t3";
  const peerStatusUrls = [...new Set(options.peerStatusUrls ?? [])];
  const peerRefreshMs = options.peerRefreshMs ?? DEFAULT_PEER_REFRESH_MS;
  state.setPeerSources(peerStatusUrls, peerRefreshMs);

  let t3Adapter: T3Adapter | null = null;
  if (t3Enabled) {
    t3Adapter = new T3Adapter({
      url: options.t3Url,
      token: options.t3Token,
      onSnapshot: (snapshot) => {
        state.applyT3Snapshot(snapshot);
      },
      onDomainEvent: (event) => {
        state.applyT3DomainEvent(event);
      },
      onConnection: (connection) => {
        state.updateT3Connection(
          connection.connected,
          connection.lastError,
          connection.lastConnectedAt
        );
      },
    });
    t3Adapter.start();
  }
  state.setT3Enabled(t3Enabled, t3Adapter ? redactToken(t3Adapter.resolvedUrl) : null);

  let peerPoller: PeerStatusPoller | null = null;
  if (peerStatusUrls.length > 0) {
    peerPoller = new PeerStatusPoller({
      urls: peerStatusUrls,
      refreshMs: peerRefreshMs,
      onUpdate: (url, update) => {
        state.updatePeerSource(url, update);
      },
    });
    peerPoller.start();
  }

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
    const effectiveT3Url = t3Adapter
      ? redactToken(t3Adapter.resolvedUrl)
      : redactToken(options.t3Url);
    const t3Line = t3Enabled
      ? `│   T3 bridge: ${effectiveT3Url}`
      : "│   T3 bridge: disabled";
    const peerLine =
      peerStatusUrls.length > 0
        ? `│   Peers: ${peerStatusUrls.length} source${peerStatusUrls.length > 1 ? "s" : ""} @ ${peerRefreshMs}ms`
        : "│   Peers: none";
    const modeLabel =
      options.provider === "auto"
        ? "Claude + T3"
        : options.provider === "claude"
        ? "Claude only"
        : "T3 only";

    console.log(`
┌─────────────────────────────────────┐
│                                     │
│   Claude Blocker Server             │
│                                     │
│   Mode: ${modeLabel.padEnd(28)}│
${t3Line.padEnd(38)}│
${peerLine.padEnd(38)}│
│   HTTP:      http://${LOCALHOST_HOST}:${port}  │
│   WebSocket: ws://${LOCALHOST_HOST}:${port}/ws │
│   Local-only: accepts loopback only │
│                                     │
│   Waiting for provider events...    │
│                                     │
└─────────────────────────────────────┘
`);
  });

  // Graceful shutdown - use once to prevent stacking handlers
  process.once("SIGINT", () => {
    console.log("\nShutting down...");
    t3Adapter?.stop();
    peerPoller?.stop();
    state.destroy();
    wss.close();
    server.close();
    process.exit(0);
  });
}
