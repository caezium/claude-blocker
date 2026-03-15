import { USER_INPUT_TOOLS } from "../types.js";
import type { HookPayload, Session } from "../types.js";

export interface ClaudeSessionStore {
  now(): number;
  ensureClaudeSession(sourceId: string, cwd?: string): Session;
  getClaudeSession(sourceId: string): Session | undefined;
  removeClaudeSession(sourceId: string): void;
  emitStateChange(): void;
}

export class ClaudeEventAdapter {
  constructor(private readonly store: ClaudeSessionStore) {}

  handleHook(payload: HookPayload): void {
    const { session_id, hook_event_name } = payload;

    switch (hook_event_name) {
      case "SessionStart": {
        this.store.ensureClaudeSession(session_id, payload.cwd);
        const session = this.store.getClaudeSession(session_id)!;
        session.status = "idle";
        session.waitingForInputSince = undefined;
        session.lastActivity = new Date(this.store.now());
        console.log("Claude Code session connected");
        break;
      }

      case "SessionEnd":
        this.store.removeClaudeSession(session_id);
        console.log("Claude Code session disconnected");
        break;

      case "UserPromptSubmit": {
        const session = this.store.ensureClaudeSession(session_id, payload.cwd);
        session.status = "working";
        session.waitingForInputSince = undefined;
        session.lastActivity = new Date(this.store.now());
        break;
      }

      case "PreToolUse": {
        const session = this.store.ensureClaudeSession(session_id, payload.cwd);

        if (payload.tool_name && USER_INPUT_TOOLS.includes(payload.tool_name)) {
          session.status = "waiting_for_input";
          session.waitingForInputSince = new Date(this.store.now());
        } else if (session.status === "waiting_for_input") {
          const elapsed = this.store.now() - (session.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > 500) {
            session.status = "working";
            session.waitingForInputSince = undefined;
          }
        } else {
          session.status = "working";
        }

        session.lastActivity = new Date(this.store.now());
        break;
      }

      case "Stop": {
        const session = this.store.ensureClaudeSession(session_id, payload.cwd);

        if (session.status === "waiting_for_input") {
          const elapsed = this.store.now() - (session.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > 500) {
            session.status = "idle";
            session.waitingForInputSince = undefined;
          }
        } else {
          session.status = "idle";
        }

        session.lastActivity = new Date(this.store.now());
        break;
      }
    }

    this.store.emitStateChange();
  }
}
