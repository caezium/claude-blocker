import assert from "node:assert/strict";
import test from "node:test";
import { mapT3SessionStatus, T3Adapter, toT3WebSocketUrl } from "../src/adapters/t3Adapter.js";

test("mapT3SessionStatus maps running/starting to working", () => {
  assert.equal(mapT3SessionStatus("running"), "working");
  assert.equal(mapT3SessionStatus("starting"), "working");
  assert.equal(mapT3SessionStatus("ready"), "idle");
  assert.equal(mapT3SessionStatus("error"), "idle");
});

test("toT3WebSocketUrl includes token query when provided", () => {
  const withToken = toT3WebSocketUrl("ws://127.0.0.1:3773", "abc123");
  assert.equal(withToken.includes("token=abc123"), true);

  const withoutToken = toT3WebSocketUrl("ws://127.0.0.1:3773");
  assert.equal(withoutToken.includes("token="), false);
});

test("adapter message handler tolerates malformed payloads", () => {
  const seen: string[] = [];
  const adapter = new T3Adapter({
    url: "ws://127.0.0.1:3773",
    onSnapshot: () => {
      seen.push("snapshot");
    },
    onDomainEvent: () => {
      seen.push("domain");
    },
    onConnection: () => {
      // no-op
    },
  });

  assert.doesNotThrow(() => {
    (adapter as any).handleRawMessage("{");
    (adapter as any).handleRawMessage(JSON.stringify({ foo: "bar" }));
  });
  assert.deepEqual(seen, []);
});

test("adapter message handler dispatches snapshot and domain events", () => {
  const seen: string[] = [];
  const adapter = new T3Adapter({
    url: "ws://127.0.0.1:3773",
    onSnapshot: () => {
      seen.push("snapshot");
    },
    onDomainEvent: () => {
      seen.push("domain");
    },
    onConnection: () => {
      // no-op
    },
  });

  (adapter as any).pendingSnapshotId = "1";
  (adapter as any).handleRawMessage(
    JSON.stringify({
      id: "1",
      result: { threads: [] },
    })
  );
  (adapter as any).handleRawMessage(
    JSON.stringify({
      type: "push",
      channel: "orchestration.domainEvent",
      data: { type: "thread.session-set", payload: {} },
    })
  );

  assert.deepEqual(seen, ["snapshot", "domain"]);
});
