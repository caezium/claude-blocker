import { SESSION_TIMEOUT_MS } from "./types.js";
import type {
  HookPayload,
  PeerConnectionState,
  ProviderMode,
  ServerMessage,
  Session,
  SessionProvider,
  SessionStatus,
  StatusResponse,
  T3ConnectionState,
  T3DomainEvent,
  T3Snapshot,
} from "./types.js";
import { ClaudeEventAdapter } from "./adapters/claudeAdapter.js";
import { mapT3SessionStatus } from "./adapters/t3Adapter.js";

type StateChangeCallback = (message: ServerMessage) => void;

interface SessionStateOptions {
  autoCleanup?: boolean;
  cleanupIntervalMs?: number;
  now?: () => number;
}

const USER_INPUT_REQUESTED_KIND = "user-input.requested";
const USER_INPUT_RESOLVED_KIND = "user-input.resolved";

function sessionKey(provider: SessionProvider, sourceId: string): string {
  return `${provider}:${sourceId}`;
}

export class SessionState {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<StateChangeCallback> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly nowFn: () => number;
  private providerMode: ProviderMode = "auto";
  private t3: T3ConnectionState = {
    enabled: false,
    url: null,
    connected: false,
    lastError: null,
    lastConnectedAt: null,
  };
  private peers: PeerConnectionState = {
    enabled: false,
    refreshMs: null,
    sources: [],
  };
  private readonly claudeAdapter: ClaudeEventAdapter;

  constructor(options: SessionStateOptions = {}) {
    this.nowFn = options.now ?? Date.now;
    this.claudeAdapter = new ClaudeEventAdapter(this);

    if (options.autoCleanup ?? true) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupStaleSessions();
      }, options.cleanupIntervalMs ?? 30_000);
      this.cleanupInterval.unref?.();
    }
  }

  now(): number {
    return this.nowFn();
  }

  setProviderMode(mode: ProviderMode): void {
    this.providerMode = mode;
  }

  setT3Enabled(enabled: boolean, url: string | null): void {
    this.t3.enabled = enabled;
    this.t3.url = url;
    if (!enabled) {
      this.t3.connected = false;
      this.t3.lastError = null;
      this.t3.lastConnectedAt = null;
      this.removeProviderSessions("t3");
      this.broadcast();
    }
  }

  setPeerSources(urls: string[], refreshMs: number): void {
    if (urls.length === 0) {
      this.peers = {
        enabled: false,
        refreshMs: null,
        sources: [],
      };
      this.broadcast();
      return;
    }

    const nextUrls = [...new Set(urls)];
    const nextByUrl = new Map(this.peers.sources.map((source) => [source.url, source]));
    const nextSources = nextUrls.map((url) => {
      const existing = nextByUrl.get(url);
      return (
        existing ?? {
          url,
          reachable: false,
          sessions: 0,
          working: 0,
          waitingForInput: 0,
          lastError: null,
          lastSeenAt: null,
        }
      );
    });

    this.peers = {
      enabled: true,
      refreshMs,
      sources: nextSources,
    };
    this.broadcast();
  }

  updatePeerSource(
    url: string,
    update: {
      reachable: boolean;
      sessions: number;
      working: number;
      waitingForInput: number;
      lastError: string | null;
      lastSeenAt: string | null;
    },
  ): void {
    const source = this.peers.sources.find((candidate) => candidate.url === url);
    if (!source) {
      return;
    }

    const changed =
      source.reachable !== update.reachable ||
      source.sessions !== update.sessions ||
      source.working !== update.working ||
      source.waitingForInput !== update.waitingForInput ||
      source.lastError !== update.lastError ||
      source.lastSeenAt !== update.lastSeenAt;

    if (!changed) {
      return;
    }

    source.reachable = update.reachable;
    source.sessions = update.sessions;
    source.working = update.working;
    source.waitingForInput = update.waitingForInput;
    source.lastError = update.lastError;
    source.lastSeenAt = update.lastSeenAt;
    this.broadcast();
  }

  updateT3Connection(connected: boolean, lastError: string | null, lastConnectedAt: string | null): void {
    this.t3.connected = connected;
    this.t3.lastError = lastError;
    if (lastConnectedAt) {
      this.t3.lastConnectedAt = lastConnectedAt;
    }
  }

  subscribe(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    callback(this.getStateMessage());
    return () => this.listeners.delete(callback);
  }

  emitStateChange(): void {
    this.broadcast();
  }

  handleHook(payload: HookPayload): void {
    this.claudeAdapter.handleHook(payload);
  }

  ensureClaudeSession(sourceId: string, cwd?: string): Session {
    return this.ensureSession("claude", sourceId, cwd);
  }

  getClaudeSession(sourceId: string): Session | undefined {
    return this.getSession("claude", sourceId);
  }

  removeClaudeSession(sourceId: string): void {
    this.removeSession("claude", sourceId);
  }

  applyT3Snapshot(snapshot: T3Snapshot): void {
    const seen = new Set<string>();
    const threads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
    const now = new Date(this.now());

    for (const thread of threads) {
      const threadId = typeof thread?.id === "string" ? thread.id : null;
      if (!threadId || !thread.session || typeof thread.session !== "object") {
        continue;
      }
      seen.add(threadId);

      const mappedStatus = mapT3SessionStatus(
        typeof thread.session.status === "string" ? thread.session.status : undefined,
      );
      const waitingForInput = this.isThreadWaitingForInput(thread);
      const session = this.ensureSession("t3", threadId);

      session.status = waitingForInput ? "waiting_for_input" : mappedStatus;
      session.waitingForInputSince = waitingForInput
        ? session.waitingForInputSince ?? now
        : undefined;
      session.lastActivity = now;
    }

    for (const [id, session] of this.sessions) {
      if (session.provider === "t3" && !seen.has(session.sourceId)) {
        this.sessions.delete(id);
      }
    }

    this.broadcast();
  }

  applyT3DomainEvent(event: T3DomainEvent): void {
    const eventType = typeof event?.type === "string" ? event.type : null;
    if (!eventType) {
      return;
    }

    let changed = false;
    const payload = event.payload;

    if (eventType === "thread.session-set") {
      const threadId = typeof payload?.threadId === "string" ? payload.threadId : null;
      if (threadId) {
        const mappedStatus = mapT3SessionStatus(payload?.session?.status);
        const session = this.ensureSession("t3", threadId);
        if (mappedStatus === "idle") {
          session.status = "idle";
          session.waitingForInputSince = undefined;
        } else if (session.status !== "waiting_for_input") {
          session.status = "working";
        }
        session.lastActivity = new Date(this.now());
        changed = true;
      }
    } else if (eventType === "thread.activity-appended") {
      const threadId = typeof payload?.threadId === "string" ? payload.threadId : null;
      const activityKind = typeof payload?.activity?.kind === "string" ? payload.activity.kind : null;
      if (threadId && activityKind) {
        const session = this.ensureSession("t3", threadId);
        if (activityKind === USER_INPUT_REQUESTED_KIND) {
          session.status = "waiting_for_input";
          session.waitingForInputSince ??= new Date(this.now());
          session.lastActivity = new Date(this.now());
          changed = true;
        } else if (activityKind === USER_INPUT_RESOLVED_KIND) {
          if (session.status === "waiting_for_input") {
            session.status = "working";
          }
          session.waitingForInputSince = undefined;
          session.lastActivity = new Date(this.now());
          changed = true;
        }
      }
    } else if (eventType === "thread.deleted") {
      const threadId = typeof payload?.threadId === "string" ? payload.threadId : null;
      if (threadId) {
        this.removeSession("t3", threadId);
        changed = true;
      }
    }

    if (changed) {
      this.broadcast();
    }
  }

  cleanupStaleSessionsNow(): void {
    this.cleanupStaleSessions();
  }

  getStatus(): StatusResponse {
    const sessions = Array.from(this.sessions.values());
    const localWorking = sessions.filter((s) => s.status === "working").length;
    const localWaitingForInput = sessions.filter((s) => s.status === "waiting_for_input").length;
    const peerTotals = this.getPeerTotals();
    const working = localWorking + peerTotals.working;
    const waitingForInput = localWaitingForInput + peerTotals.waitingForInput;
    return {
      blocked: working === 0 && waitingForInput === 0,
      sessions,
      working,
      waitingForInput,
      t3: { ...this.t3 },
      peers: {
        enabled: this.peers.enabled,
        refreshMs: this.peers.refreshMs,
        sources: this.peers.sources.map((source) => ({ ...source })),
      },
      providerMode: this.providerMode,
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    this.listeners.clear();
  }

  private broadcast(): void {
    const message = this.getStateMessage();
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private getStateMessage(): ServerMessage {
    const sessions = Array.from(this.sessions.values());
    const localWorking = sessions.filter((s) => s.status === "working").length;
    const localWaitingForInput = sessions.filter((s) => s.status === "waiting_for_input").length;
    const localSessions = sessions.length;
    const peerTotals = this.getPeerTotals();
    const working = localWorking + peerTotals.working;
    const waitingForInput = localWaitingForInput + peerTotals.waitingForInput;
    return {
      type: "state",
      blocked: working === 0 && waitingForInput === 0,
      sessions: localSessions + peerTotals.sessions,
      working,
      waitingForInput,
    };
  }

  private getPeerTotals(): { sessions: number; working: number; waitingForInput: number } {
    let sessions = 0;
    let working = 0;
    let waitingForInput = 0;

    for (const source of this.peers.sources) {
      if (!source.reachable) {
        continue;
      }
      sessions += source.sessions;
      working += source.working;
      waitingForInput += source.waitingForInput;
    }

    return { sessions, working, waitingForInput };
  }

  private ensureSession(provider: SessionProvider, sourceId: string, cwd?: string): Session {
    const key = sessionKey(provider, sourceId);
    const existing = this.sessions.get(key);
    if (existing) {
      if (cwd) {
        existing.cwd = cwd;
      }
      return existing;
    }

    const session: Session = {
      id: key,
      provider,
      sourceId,
      status: "idle",
      lastActivity: new Date(this.now()),
      cwd,
    };
    this.sessions.set(key, session);
    return session;
  }

  private getSession(provider: SessionProvider, sourceId: string): Session | undefined {
    return this.sessions.get(sessionKey(provider, sourceId));
  }

  private removeSession(provider: SessionProvider, sourceId: string): void {
    this.sessions.delete(sessionKey(provider, sourceId));
  }

  private removeProviderSessions(provider: SessionProvider): void {
    for (const [id, session] of this.sessions) {
      if (session.provider === provider) {
        this.sessions.delete(id);
      }
    }
  }

  private cleanupStaleSessions(): void {
    const now = this.now();
    let removed = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
        this.sessions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.broadcast();
    }
  }

  private isThreadWaitingForInput(thread: NonNullable<T3Snapshot["threads"]>[number]): boolean {
    const session = thread?.session;
    if (!session || session.activeTurnId === null || session.activeTurnId === undefined) {
      return false;
    }

    const activities = Array.isArray(thread.activities) ? thread.activities : [];
    for (let i = activities.length - 1; i >= 0; i--) {
      const kind = activities[i]?.kind;
      if (kind === USER_INPUT_REQUESTED_KIND) {
        return true;
      }
      if (kind === USER_INPUT_RESOLVED_KIND) {
        return false;
      }
    }
    return false;
  }
}

export const state = new SessionState();
