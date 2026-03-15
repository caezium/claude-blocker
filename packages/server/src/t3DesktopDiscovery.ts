import { spawnSync } from "child_process";

const DESKTOP_SERVER_COMMAND_FRAGMENT = "apps/server/dist/index.mjs";
const DESKTOP_WS_ENV_KEY = "T3CODE_DESKTOP_WS_URL";

interface CommandResult {
  status: number | null;
  stdout: string;
}

type CommandRunner = (command: string, args: string[]) => CommandResult;

function defaultCommandRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

export function extractDesktopServerPid(psOutput: string): string | undefined {
  const lines = psOutput.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const pid = match[1];
    const command = match[2];
    if (command.includes(DESKTOP_SERVER_COMMAND_FRAGMENT)) {
      return pid;
    }
  }
  return undefined;
}

export function extractDesktopWsUrl(psEnvOutput: string): string | undefined {
  const match = psEnvOutput.match(new RegExp(`\\b${DESKTOP_WS_ENV_KEY}=([^\\s]+)`));
  if (!match || !match[1]) {
    return undefined;
  }

  try {
    const parsed = new URL(match[1]);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

interface DetectOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

export function detectT3DesktopWsUrl(options: DetectOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return undefined;
  }

  const run = options.run ?? defaultCommandRunner;

  const listProcesses = run("ps", ["-ax", "-o", "pid=,command="]);
  if (listProcesses.status !== 0) {
    return undefined;
  }

  const pid = extractDesktopServerPid(listProcesses.stdout);
  if (!pid) {
    return undefined;
  }

  const processEnv = run("ps", ["eww", "-p", pid]);
  if (processEnv.status !== 0) {
    return undefined;
  }

  return extractDesktopWsUrl(processEnv.stdout);
}

