import { WebSocket } from "ws";
import type { T3DomainEvent, T3Snapshot } from "../types.js";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const SNAPSHOT_REQUEST_TAG = "orchestration.getSnapshot";
const DOMAIN_EVENT_CHANNEL = "orchestration.domainEvent";

export function toT3WebSocketUrl(baseUrl: string, token?: string): string {
  const parsed = new URL(baseUrl);
  if (token) {
    parsed.searchParams.set("token", token);
  }
  return parsed.toString();
}

export function mapT3SessionStatus(status: string | undefined): "working" | "idle" {
  return status === "running" || status === "starting" ? "working" : "idle";
}

interface T3ConnectionInfo {
  connected: boolean;
  lastError: string | null;
  lastConnectedAt: string | null;
}

interface T3AdapterOptions {
  url: string;
  token?: string;
  onSnapshot: (snapshot: T3Snapshot) => void;
  onDomainEvent: (event: T3DomainEvent) => void;
  onConnection: (state: T3ConnectionInfo) => void;
}

export class T3Adapter {
  private ws: WebSocket | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private nextRequestId = 1;
  private pendingSnapshotId: string | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: string | null = null;

  readonly resolvedUrl: string;

  constructor(private readonly options: T3AdapterOptions) {
    this.resolvedUrl = toT3WebSocketUrl(options.url, options.token);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.pendingSnapshotId = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.emitConnection(false, null);
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.resolvedUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.lastConnectedAt = new Date().toISOString();
      this.emitConnection(true, null);
      this.requestSnapshot();
    });

    ws.on("message", (raw) => {
      if (typeof raw === "string") {
        this.handleRawMessage(raw);
        return;
      }
      if (raw instanceof Buffer) {
        this.handleRawMessage(raw.toString("utf-8"));
      }
    });

    ws.on("error", (error) => {
      this.lastError = error.message || "T3 connection error";
      this.emitConnection(false, this.lastError);
    });

    ws.on("close", () => {
      this.emitConnection(false, this.lastError);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimeout) {
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  private requestSnapshot(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const requestId = String(this.nextRequestId++);
    this.pendingSnapshotId = requestId;
    ws.send(
      JSON.stringify({
        id: requestId,
        body: {
          _tag: SNAPSHOT_REQUEST_TAG,
        },
      }),
    );
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const candidate = parsed as Record<string, unknown>;
    if (candidate.type === "push" && candidate.channel === DOMAIN_EVENT_CHANNEL) {
      this.options.onDomainEvent(candidate.data as T3DomainEvent);
      return;
    }

    const id = typeof candidate.id === "string" ? candidate.id : null;
    if (id && this.pendingSnapshotId && id === this.pendingSnapshotId) {
      this.pendingSnapshotId = null;
      if (candidate.result && typeof candidate.result === "object") {
        this.options.onSnapshot(candidate.result as T3Snapshot);
      } else if (candidate.error && typeof candidate.error === "object") {
        const message = (candidate.error as { message?: unknown }).message;
        this.lastError = typeof message === "string" ? message : "T3 snapshot request failed";
        this.emitConnection(true, this.lastError);
      }
    }
  }

  private emitConnection(connected: boolean, lastError: string | null): void {
    this.options.onConnection({
      connected,
      lastError,
      lastConnectedAt: this.lastConnectedAt,
    });
  }
}
