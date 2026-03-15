import assert from "node:assert/strict";
import test from "node:test";
import {
  detectT3DesktopWsUrl,
  extractDesktopServerPid,
  extractDesktopWsUrl,
} from "../src/t3DesktopDiscovery.js";

test("extractDesktopServerPid returns pid for desktop server process", () => {
  const output = `
  100 /usr/bin/some-other-process
  75293 /Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha) /Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/index.mjs
`;

  assert.equal(extractDesktopServerPid(output), "75293");
});

test("extractDesktopServerPid returns undefined when desktop process is absent", () => {
  const output = `
  100 /usr/bin/some-other-process
  101 /usr/bin/another-process
`;

  assert.equal(extractDesktopServerPid(output), undefined);
});

test("extractDesktopWsUrl returns ws url from process environment", () => {
  const output =
    "PID TT STAT TIME COMMAND T3CODE_DESKTOP_WS_URL=ws://127.0.0.1:57799/?token=abc T3CODE_MODE=desktop";

  assert.equal(extractDesktopWsUrl(output), "ws://127.0.0.1:57799/?token=abc");
});

test("extractDesktopWsUrl rejects invalid protocol", () => {
  const output =
    "PID TT STAT TIME COMMAND T3CODE_DESKTOP_WS_URL=http://127.0.0.1:57799/?token=abc T3CODE_MODE=desktop";

  assert.equal(extractDesktopWsUrl(output), undefined);
});

test("detectT3DesktopWsUrl resolves url using command runner on darwin", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "ps" && args.join(" ") === "-ax -o pid=,command=") {
      return {
        status: 0,
        stdout:
          "75293 /Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha) /Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/index.mjs\n",
      };
    }
    if (command === "ps" && args.join(" ") === "eww -p 75293") {
      return {
        status: 0,
        stdout:
          "PID TT STAT TIME COMMAND T3CODE_DESKTOP_WS_URL=ws://127.0.0.1:57799/?token=abc T3CODE_MODE=desktop",
      };
    }
    return { status: 1, stdout: "" };
  };

  const result = detectT3DesktopWsUrl({ platform: "darwin", run });
  assert.equal(result, "ws://127.0.0.1:57799/?token=abc");
  assert.deepEqual(calls, [
    { command: "ps", args: ["-ax", "-o", "pid=,command="] },
    { command: "ps", args: ["eww", "-p", "75293"] },
  ]);
});

test("detectT3DesktopWsUrl is disabled on non-darwin platforms", () => {
  let called = false;
  const result = detectT3DesktopWsUrl({
    platform: "linux",
    run: () => {
      called = true;
      return { status: 0, stdout: "" };
    },
  });

  assert.equal(result, undefined);
  assert.equal(called, false);
});

