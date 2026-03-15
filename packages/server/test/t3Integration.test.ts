import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import { T3Adapter } from "../src/adapters/t3Adapter.js";
import { SessionState } from "../src/state.js";
import type { T3DomainEvent, T3Snapshot } from "../src/types.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000,
  pollMs = 20,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function wsUrl(server: WebSocketServer): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected WebSocketServer to listen on TCP");
  }
  return `ws://127.0.0.1:${address.port}`;
}

function emitDomainEvent(server: WebSocketServer, event: T3DomainEvent): void {
  const payload = JSON.stringify({
    type: "push",
    channel: "orchestration.domainEvent",
    data: event,
  });

  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("mock t3 events drive blocker state transitions", async () => {
  const snapshots: T3Snapshot[] = [
    {
      threads: [
        {
          id: "thread-1",
          session: { status: "running", activeTurnId: "turn-1" },
          activities: [],
        },
      ],
    },
  ];

  const t3Server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(t3Server, "listening");

  t3Server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: string; body?: { _tag?: string } };
      if (message.body?._tag === "orchestration.getSnapshot") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: snapshots[0],
          }),
        );
      }
    });
  });

  const sessionState = new SessionState({ autoCleanup: false });
  const adapter = new T3Adapter({
    url: wsUrl(t3Server),
    onSnapshot: (snapshot) => sessionState.applyT3Snapshot(snapshot),
    onDomainEvent: (event) => sessionState.applyT3DomainEvent(event),
    onConnection: () => {
      // no-op
    },
  });

  adapter.start();

  await waitFor(() => sessionState.getStatus().working === 1);
  assert.equal(sessionState.getStatus().blocked, false);

  emitDomainEvent(t3Server, {
    type: "thread.session-set",
    payload: { threadId: "thread-1", session: { status: "ready" } },
  });

  await waitFor(() => sessionState.getStatus().blocked === true);
  assert.equal(sessionState.getStatus().working, 0);
  assert.equal(sessionState.getStatus().waitingForInput, 0);

  emitDomainEvent(t3Server, {
    type: "thread.activity-appended",
    payload: { threadId: "thread-1", activity: { kind: "user-input.requested" } },
  });
  await waitFor(() => sessionState.getStatus().waitingForInput === 1);
  assert.equal(sessionState.getStatus().blocked, false);

  emitDomainEvent(t3Server, {
    type: "thread.activity-appended",
    payload: { threadId: "thread-1", activity: { kind: "user-input.resolved" } },
  });
  await waitFor(() => sessionState.getStatus().waitingForInput === 0);

  adapter.stop();
  sessionState.destroy();
  await closeServer(t3Server);
});

test("adapter reconnect rehydrates state from snapshot", async () => {
  let snapshotIndex = 0;
  const snapshots: T3Snapshot[] = [
    {
      threads: [
        {
          id: "thread-reconnect",
          session: { status: "running", activeTurnId: "turn-a" },
          activities: [],
        },
      ],
    },
    {
      threads: [],
    },
  ];

  const t3Server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(t3Server, "listening");

  t3Server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: string; body?: { _tag?: string } };
      if (message.body?._tag === "orchestration.getSnapshot") {
        const next = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        socket.send(
          JSON.stringify({
            id: message.id,
            result: next,
          }),
        );
      }
    });
  });

  const sessionState = new SessionState({ autoCleanup: false });
  const adapter = new T3Adapter({
    url: wsUrl(t3Server),
    onSnapshot: (snapshot) => sessionState.applyT3Snapshot(snapshot),
    onDomainEvent: (event) => sessionState.applyT3DomainEvent(event),
    onConnection: () => {
      // no-op
    },
  });

  adapter.start();
  await waitFor(() => sessionState.getStatus().working === 1);

  for (const client of t3Server.clients) {
    client.close();
  }

  await waitFor(() => sessionState.getStatus().sessions.length === 0, 6_000);
  assert.equal(sessionState.getStatus().blocked, true);

  adapter.stop();
  sessionState.destroy();
  await closeServer(t3Server);
});
