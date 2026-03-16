import { DEFAULT_PEER_REFRESH_MS, DEFAULT_PORT, DEFAULT_T3_WS_URL } from "./types.js";
import type { ProviderMode } from "./types.js";

export interface CliOptions {
  port: number;
  provider: ProviderMode;
  t3Url: string;
  t3UrlProvided: boolean;
  t3Token?: string;
  peerStatusUrls: string[];
  peerRefreshMs: number;
  setup: boolean;
  remove: boolean;
  help: boolean;
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed >= 65536) {
    return null;
  }
  return parsed;
}

function parseProvider(raw: string | undefined): ProviderMode | null {
  if (!raw) {
    return null;
  }
  return raw === "auto" || raw === "claude" || raw === "t3" ? raw : null;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function parseCliArgs(args: string[]): CliOptions {
  const help = args.includes("--help") || args.includes("-h");
  const setup = args.includes("--setup");
  const remove = args.includes("--remove");

  let port = DEFAULT_PORT;
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1) {
    const parsed = parsePort(args[portIndex + 1]);
    if (parsed === null) {
      throw new Error("Invalid port number");
    }
    port = parsed;
  }

  let provider: ProviderMode = "auto";
  const providerIndex = args.indexOf("--provider");
  if (providerIndex !== -1) {
    const parsed = parseProvider(args[providerIndex + 1]);
    if (!parsed) {
      throw new Error("Invalid provider. Use: auto, claude, or t3");
    }
    provider = parsed;
  }

  let t3Url = DEFAULT_T3_WS_URL;
  let t3UrlProvided = false;
  const t3UrlIndex = args.indexOf("--t3-url");
  if (t3UrlIndex !== -1) {
    const candidate = args[t3UrlIndex + 1];
    if (!candidate) {
      throw new Error("Missing value for --t3-url");
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new Error("invalid protocol");
      }
      t3Url = parsed.toString();
      t3UrlProvided = true;
    } catch {
      throw new Error("Invalid T3 URL. Expected ws:// or wss:// URL");
    }
  }

  let t3Token: string | undefined;
  const t3TokenIndex = args.indexOf("--t3-token");
  if (t3TokenIndex !== -1) {
    const candidate = args[t3TokenIndex + 1];
    if (!candidate) {
      throw new Error("Missing value for --t3-token");
    }
    t3Token = candidate;
  }

  const peerStatusUrls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--peer-status-url") {
      continue;
    }
    const candidate = args[i + 1];
    if (!candidate) {
      throw new Error("Missing value for --peer-status-url");
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("invalid protocol");
      }
      peerStatusUrls.push(parsed.toString());
    } catch {
      throw new Error("Invalid peer status URL. Expected http:// or https:// URL");
    }
  }

  let peerRefreshMs = DEFAULT_PEER_REFRESH_MS;
  const peerRefreshIndex = args.indexOf("--peer-refresh-ms");
  if (peerRefreshIndex !== -1) {
    const parsed = parsePositiveInt(args[peerRefreshIndex + 1]);
    if (parsed === null) {
      throw new Error("Invalid peer refresh interval. Use milliseconds > 0");
    }
    peerRefreshMs = parsed;
  }

  return {
    port,
    provider,
    t3Url,
    t3UrlProvided,
    t3Token,
    peerStatusUrls,
    peerRefreshMs,
    setup,
    remove,
    help,
  };
}

export function printHelp(): void {
  console.log(`
Claude Blocker - Block distracting sites unless your coding agent is working

Usage:
  npx claude-blocker [options]

Options:
  --setup               Configure Claude Code hooks
  --remove              Remove Claude Code hooks
  --provider <mode>     Provider mode: auto | claude | t3 (default: auto)
  --t3-url <ws-url>     T3 WebSocket URL (default: ${DEFAULT_T3_WS_URL})
  --t3-token <token>    T3 WebSocket auth token (optional)
  --peer-status-url     Remote blocker /status URL (repeatable)
  --peer-refresh-ms     Peer status poll interval in ms (default: ${DEFAULT_PEER_REFRESH_MS})
  --port <number>       Server port (default: ${DEFAULT_PORT})
  --help                Show this help message

Examples:
  npx claude-blocker
  npx claude-blocker --provider t3
  npx claude-blocker --provider auto --t3-url ws://127.0.0.1:3773
  npx claude-blocker --peer-status-url https://studio.tailnet.ts.net/status
  npx claude-blocker --setup
`);
}
