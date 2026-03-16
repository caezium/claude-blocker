// Hook event payload (from Claude Code)
export interface HookPayload {
  session_id: string;
  hook_event_name:
    | "UserPromptSubmit"
    | "PreToolUse"
    | "Stop"
    | "SessionStart"
    | "SessionEnd";
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
}

export type ProviderMode = "auto" | "claude" | "t3";
export type SessionProvider = "claude" | "t3";
export type SessionStatus = "idle" | "working" | "waiting_for_input";

// Session state tracked by server
export interface Session {
  id: string;
  provider: SessionProvider;
  sourceId: string;
  status: SessionStatus;
  lastActivity: Date;
  waitingForInputSince?: Date;
  cwd?: string;
}

export interface T3ConnectionState {
  enabled: boolean;
  url: string | null;
  connected: boolean;
  lastError: string | null;
  lastConnectedAt: string | null;
}

export interface PeerSourceState {
  url: string;
  reachable: boolean;
  sessions: number;
  working: number;
  waitingForInput: number;
  lastError: string | null;
  lastSeenAt: string | null;
}

export interface PeerConnectionState {
  enabled: boolean;
  refreshMs: number | null;
  sources: PeerSourceState[];
}

export interface StatusResponse {
  blocked: boolean;
  sessions: Session[];
  working: number;
  waitingForInput: number;
  t3: T3ConnectionState;
  peers: PeerConnectionState;
  providerMode: ProviderMode;
}

// WebSocket messages from server to extension
export type ServerMessage =
  | {
      type: "state";
      blocked: boolean;
      sessions: number;
      working: number;
      waitingForInput: number;
    }
  | { type: "pong" };

// Tools that indicate Claude is waiting for user input
export const USER_INPUT_TOOLS = [
  "AskUserQuestion",
  "ask_user",
  "ask_human",
];

// WebSocket messages from extension to server
export type ClientMessage = { type: "ping" } | { type: "subscribe" };

// Server configuration
export const DEFAULT_PORT = 8765;
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_T3_WS_URL = "ws://127.0.0.1:3773";
export const DEFAULT_PEER_REFRESH_MS = 5_000;
export const DEFAULT_HOST = "127.0.0.1";

export interface StartServerOptions {
  provider: ProviderMode;
  t3Url: string;
  t3Token?: string;
  host?: string;
  peerStatusUrls?: string[];
  peerRefreshMs?: number;
}

export interface T3Snapshot {
  threads?: Array<{
    id?: string;
    session?: {
      status?: string;
      activeTurnId?: string | null;
    };
    activities?: Array<{ kind?: string }>;
  }>;
}

export interface T3DomainEvent {
  type?: string;
  payload?: {
    threadId?: string;
    session?: { status?: string };
    activity?: { kind?: string };
  };
}
