import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli.js";

test("parseCliArgs returns defaults", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.port, 8765);
  assert.equal(parsed.provider, "auto");
  assert.equal(parsed.t3Url, "ws://127.0.0.1:3773");
  assert.equal(parsed.t3UrlProvided, false);
  assert.equal(parsed.setup, false);
  assert.equal(parsed.remove, false);
  assert.equal(parsed.help, false);
});

test("parseCliArgs parses provider and t3 options", () => {
  const parsed = parseCliArgs([
    "--provider",
    "t3",
    "--t3-url",
    "ws://localhost:3773",
    "--t3-token",
    "secret",
    "--port",
    "9000",
  ]);
  assert.equal(parsed.provider, "t3");
  assert.equal(parsed.t3Url, "ws://localhost:3773/");
  assert.equal(parsed.t3UrlProvided, true);
  assert.equal(parsed.t3Token, "secret");
  assert.equal(parsed.port, 9000);
});

test("parseCliArgs rejects invalid provider", () => {
  assert.throws(
    () => parseCliArgs(["--provider", "bad"]),
    /Invalid provider/
  );
});

test("parseCliArgs rejects invalid t3 url", () => {
  assert.throws(
    () => parseCliArgs(["--t3-url", "http://localhost:3773"]),
    /Invalid T3 URL/
  );
});
