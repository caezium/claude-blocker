import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli.js";

test("parseCliArgs returns defaults", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.port, 8765);
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.provider, "auto");
  assert.equal(parsed.t3Url, "ws://127.0.0.1:3773");
  assert.equal(parsed.t3UrlProvided, false);
  assert.deepEqual(parsed.peerStatusUrls, []);
  assert.equal(parsed.peerRefreshMs, 5000);
  assert.equal(parsed.setup, false);
  assert.equal(parsed.remove, false);
  assert.equal(parsed.help, false);
});

test("parseCliArgs parses provider and t3 options", () => {
  const parsed = parseCliArgs([
    "--host",
    "0.0.0.0",
    "--provider",
    "t3",
    "--t3-url",
    "ws://localhost:3773",
    "--t3-token",
    "secret",
    "--port",
    "9000",
  ]);
  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed.provider, "t3");
  assert.equal(parsed.t3Url, "ws://localhost:3773/");
  assert.equal(parsed.t3UrlProvided, true);
  assert.equal(parsed.t3Token, "secret");
  assert.equal(parsed.port, 9000);
});

test("parseCliArgs parses repeatable peer status urls", () => {
  const parsed = parseCliArgs([
    "--peer-status-url",
    "https://studio.tailnet.ts.net/status",
    "--peer-status-url",
    "http://192.168.1.5:8765/status",
    "--peer-refresh-ms",
    "2000",
  ]);

  assert.deepEqual(parsed.peerStatusUrls, [
    "https://studio.tailnet.ts.net/status",
    "http://192.168.1.5:8765/status",
  ]);
  assert.equal(parsed.peerRefreshMs, 2000);
});

test("parseCliArgs rejects invalid provider", () => {
  assert.throws(
    () => parseCliArgs(["--provider", "bad"]),
    /Invalid provider/
  );
});

test("parseCliArgs rejects invalid host", () => {
  assert.throws(
    () => parseCliArgs(["--host", "192.168.1.5"]),
    /Invalid host/
  );
});

test("parseCliArgs rejects invalid t3 url", () => {
  assert.throws(
    () => parseCliArgs(["--t3-url", "http://localhost:3773"]),
    /Invalid T3 URL/
  );
});

test("parseCliArgs rejects invalid peer status url", () => {
  assert.throws(
    () => parseCliArgs(["--peer-status-url", "ws://127.0.0.1:8765/status"]),
    /Invalid peer status URL/
  );
});

test("parseCliArgs rejects invalid peer refresh interval", () => {
  assert.throws(
    () => parseCliArgs(["--peer-refresh-ms", "0"]),
    /Invalid peer refresh interval/
  );
});
