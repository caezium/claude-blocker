import type { Session, HookPayload, ServerMessage } from "./types.js";
import { SESSION_TIMEOUT_MS, USER_INPUT_TOOLS } from "./types.js";

type StateChangeCallback = (message: ServerMessage) => void;

interface SessionStateOptions {
  autoCleanup?: boolean;
  cleanupIntervalMs?: number;
  now?: () => number;
}

export class SessionState {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<StateChangeCallback> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(options: SessionStateOptions = {}) {
    this.now = options.now ?? Date.now;

    // Start cleanup interval for stale sessions
    if (options.autoCleanup ?? true) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupStaleSessions();
      }, options.cleanupIntervalMs ?? 30_000); // Check every 30 seconds
      this.cleanupInterval.unref?.();
    }
  }

  subscribe(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    // Immediately send current state to new subscriber
    callback(this.getStateMessage());
    return () => this.listeners.delete(callback);
  }

  private broadcast(): void {
    const message = this.getStateMessage();
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private getStateMessage(): ServerMessage {
    const sessions = Array.from(this.sessions.values());
    const working = sessions.filter((s) => s.status === "working").length;
    const waitingForInput = sessions.filter(
      (s) => s.status === "waiting_for_input"
    ).length;
    return {
      type: "state",
      blocked: working === 0 && waitingForInput === 0,
      sessions: sessions.length,
      working,
      waitingForInput,
    };
  }

  handleHook(payload: HookPayload): void {
    const { session_id, hook_event_name } = payload;

    switch (hook_event_name) {
      case "SessionStart":
        this.sessions.set(session_id, {
          id: session_id,
          status: "idle",
          lastActivity: new Date(this.now()),
          cwd: payload.cwd,
        });
        console.log("Claude Code session connected");
        break;

      case "SessionEnd":
        this.sessions.delete(session_id);
        console.log("Claude Code session disconnected");
        break;

      case "UserPromptSubmit":
        this.ensureSession(session_id, payload.cwd);
        const promptSession = this.sessions.get(session_id)!;
        promptSession.status = "working";
        promptSession.waitingForInputSince = undefined;
        promptSession.lastActivity = new Date(this.now());
        break;

      case "PreToolUse":
        this.ensureSession(session_id, payload.cwd);
        const toolSession = this.sessions.get(session_id)!;
        // Check if this is a user input tool
        if (payload.tool_name && USER_INPUT_TOOLS.includes(payload.tool_name)) {
          toolSession.status = "waiting_for_input";
          toolSession.waitingForInputSince = new Date(this.now());
        } else if (toolSession.status === "waiting_for_input") {
          // If waiting for input, only reset after 500ms (to ignore immediate tool calls like Edit)
          const elapsed = this.now() - (toolSession.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > 500) {
            toolSession.status = "working";
            toolSession.waitingForInputSince = undefined;
          }
        } else {
          toolSession.status = "working";
        }
        toolSession.lastActivity = new Date(this.now());
        break;

      case "Stop":
        this.ensureSession(session_id, payload.cwd);
        const idleSession = this.sessions.get(session_id)!;
        if (idleSession.status === "waiting_for_input") {
          // If waiting for input, only reset after 500ms (to ignore immediate Stop after AskUserQuestion)
          const elapsed = this.now() - (idleSession.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > 500) {
            idleSession.status = "idle";
            idleSession.waitingForInputSince = undefined;
          }
        } else {
          idleSession.status = "idle";
        }
        idleSession.lastActivity = new Date(this.now());
        break;
    }

    this.broadcast();
  }

  private ensureSession(sessionId: string, cwd?: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        status: "idle",
        lastActivity: new Date(this.now()),
        cwd,
      });
      console.log("Claude Code session connected");
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

  cleanupStaleSessionsNow(): void {
    this.cleanupStaleSessions();
  }

  getStatus(): {
    blocked: boolean;
    sessions: Session[];
    working: number;
    waitingForInput: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const working = sessions.filter((s) => s.status === "working").length;
    const waitingForInput = sessions.filter(
      (s) => s.status === "waiting_for_input"
    ).length;
    return {
      blocked: working === 0 && waitingForInput === 0,
      sessions,
      working,
      waitingForInput,
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    this.listeners.clear();
  }
}

export const state = new SessionState();
