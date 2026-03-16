import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { PeerStatusPoller } from "../src/adapters/peerStatusPoller.js";

interface PeerUpdate {
  reachable: boolean;
  sessions: number;
  working: number;
  waitingForInput: number;
  lastError: string | null;
  lastSeenAt: string | null;
}

function statusUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}/status`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function pollOnce(url: string): Promise<PeerUpdate> {
  return new Promise((resolve) => {
    const poller = new PeerStatusPoller({
      urls: [url],
      refreshMs: 60_000,
      onUpdate: (sourceUrl, update) => {
        if (sourceUrl !== url) {
          return;
        }
        poller.stop();
        resolve(update);
      },
    });
    poller.start();
  });
}

test("peer poller parses sessions array payloads", async () => {
  const server = createServer((req, res) => {
    if (req.url !== "/status") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [{ id: "a" }, { id: "b" }], working: 1, waitingForInput: 0 }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const update = await pollOnce(statusUrl(server));
  assert.equal(update.reachable, true);
  assert.equal(update.sessions, 2);
  assert.equal(update.working, 1);
  assert.equal(update.waitingForInput, 0);
  assert.equal(update.lastError, null);
  assert.equal(typeof update.lastSeenAt, "string");

  await closeServer(server);
});

test("peer poller parses numeric session counts", async () => {
  const server = createServer((req, res) => {
    if (req.url !== "/status") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: 3, working: 2, waitingForInput: 1 }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const update = await pollOnce(statusUrl(server));
  assert.equal(update.reachable, true);
  assert.equal(update.sessions, 3);
  assert.equal(update.working, 2);
  assert.equal(update.waitingForInput, 1);
  assert.equal(update.lastError, null);

  await closeServer(server);
});

test("peer poller marks unreachable peers without crashing", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const url = statusUrl(server);
  await closeServer(server);

  const update = await pollOnce(url);
  assert.equal(update.reachable, false);
  assert.equal(update.sessions, 0);
  assert.equal(update.working, 0);
  assert.equal(update.waitingForInput, 0);
  assert.equal(typeof update.lastError, "string");
  assert.ok(update.lastError && update.lastError.length > 0);
  assert.equal(update.lastSeenAt, null);
});
