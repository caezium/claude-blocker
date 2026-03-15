import assert from "node:assert/strict";
import test from "node:test";
import { SessionState } from "../src/state.js";
import { SESSION_TIMEOUT_MS } from "../src/types.js";

test("waiting_for_input keeps sessions unblocked until input timeout passes", () => {
  let now = 1_000;
  const sessionState = new SessionState({ autoCleanup: false, now: () => now });

  sessionState.handleHook({ session_id: "s1", hook_event_name: "SessionStart" });
  assert.equal(sessionState.getStatus().blocked, true);

  sessionState.handleHook({ session_id: "s1", hook_event_name: "UserPromptSubmit" });
  assert.equal(sessionState.getStatus().working, 1);
  assert.equal(sessionState.getStatus().blocked, false);

  sessionState.handleHook({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
  });

  let status = sessionState.getStatus();
  assert.equal(status.working, 0);
  assert.equal(status.waitingForInput, 1);
  assert.equal(status.blocked, false);

  now += 100;
  sessionState.handleHook({ session_id: "s1", hook_event_name: "Stop" });
  status = sessionState.getStatus();
  assert.equal(status.waitingForInput, 1);
  assert.equal(status.blocked, false);

  now += 600;
  sessionState.handleHook({ session_id: "s1", hook_event_name: "Stop" });
  status = sessionState.getStatus();
  assert.equal(status.waitingForInput, 0);
  assert.equal(status.blocked, true);

  sessionState.destroy();
});

test("t3 snapshot maps running and ready states correctly", () => {
  let now = 100;
  const sessionState = new SessionState({ autoCleanup: false, now: () => now });

  sessionState.applyT3Snapshot({
    threads: [
      {
        id: "thr-running",
        session: { status: "running", activeTurnId: "turn-1" },
        activities: [],
      },
      {
        id: "thr-ready",
        session: { status: "ready", activeTurnId: null },
        activities: [],
      },
    ],
  });

  const status = sessionState.getStatus();
  assert.equal(status.working, 1);
  assert.equal(status.waitingForInput, 0);
  assert.equal(status.sessions.length, 2);
  assert.equal(status.blocked, false);

  sessionState.destroy();
});

test("t3 activity events toggle waiting_for_input", () => {
  let now = 500;
  const sessionState = new SessionState({ autoCleanup: false, now: () => now });

  sessionState.applyT3DomainEvent({
    type: "thread.session-set",
    payload: {
      threadId: "thr-1",
      session: { status: "running" },
    },
  });

  let status = sessionState.getStatus();
  assert.equal(status.working, 1);
  assert.equal(status.waitingForInput, 0);

  now += 10;
  sessionState.applyT3DomainEvent({
    type: "thread.activity-appended",
    payload: {
      threadId: "thr-1",
      activity: { kind: "user-input.requested" },
    },
  });

  status = sessionState.getStatus();
  assert.equal(status.working, 0);
  assert.equal(status.waitingForInput, 1);
  assert.equal(status.blocked, false);

  now += 10;
  sessionState.applyT3DomainEvent({
    type: "thread.activity-appended",
    payload: {
      threadId: "thr-1",
      activity: { kind: "user-input.resolved" },
    },
  });

  status = sessionState.getStatus();
  assert.equal(status.working, 1);
  assert.equal(status.waitingForInput, 0);

  sessionState.destroy();
});

test("claude and t3 sessions stay isolated by provider-prefixed ids", () => {
  const sessionState = new SessionState({ autoCleanup: false, now: () => 1_000 });

  sessionState.handleHook({
    session_id: "same-id",
    hook_event_name: "UserPromptSubmit",
  });
  sessionState.applyT3DomainEvent({
    type: "thread.session-set",
    payload: {
      threadId: "same-id",
      session: { status: "running" },
    },
  });

  const status = sessionState.getStatus();
  assert.equal(status.sessions.length, 2);
  assert.equal(status.sessions.some((session) => session.id === "claude:same-id"), true);
  assert.equal(status.sessions.some((session) => session.id === "t3:same-id"), true);

  sessionState.destroy();
});

test("stale sessions are removed during cleanup", () => {
  let now = 10_000;
  const sessionState = new SessionState({ autoCleanup: false, now: () => now });

  sessionState.handleHook({ session_id: "s2", hook_event_name: "SessionStart" });
  assert.equal(sessionState.getStatus().sessions.length, 1);

  now += SESSION_TIMEOUT_MS + 1;
  sessionState.cleanupStaleSessionsNow();

  const status = sessionState.getStatus();
  assert.equal(status.sessions.length, 0);
  assert.equal(status.blocked, true);

  sessionState.destroy();
});
