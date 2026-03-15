#!/usr/bin/env node

import { createInterface } from "readline";
import { startServer } from "./server.js";
import { setupHooks, removeHooks, areHooksConfigured } from "./setup.js";
import { parseCliArgs, printHelp } from "./cli.js";
import { detectT3DesktopWsUrl } from "./t3DesktopDiscovery.js";

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid CLI arguments");
    process.exit(1);
  }

  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  if (cli.setup) {
    setupHooks(cli.port);
    process.exit(0);
  }

  if (cli.remove) {
    removeHooks();
    process.exit(0);
  }

  if (cli.provider !== "t3" && !areHooksConfigured(cli.port)) {
    console.log(`Claude Blocker hooks are not configured for port ${cli.port}.\n`);
    const answer = await prompt("Would you like to set them up now? (Y/n) ");
    const normalized = answer.trim().toLowerCase();

    if (normalized === "" || normalized === "y" || normalized === "yes") {
      setupHooks(cli.port);
      console.log("");
    } else {
      console.log("\nSkipping setup. You can run 'npx claude-blocker --setup' later.\n");
    }
  }

  let t3Url = cli.t3Url;
  let t3Token = cli.t3Token;
  const includesT3 = cli.provider === "auto" || cli.provider === "t3";
  if (includesT3 && !cli.t3UrlProvided) {
    const detectedDesktopUrl = detectT3DesktopWsUrl();
    if (detectedDesktopUrl) {
      t3Url = detectedDesktopUrl;
      t3Token = undefined;
      const displayUrl = new URL(detectedDesktopUrl);
      if (displayUrl.searchParams.has("token")) {
        displayUrl.searchParams.set("token", "***");
      }
      console.log(`Detected T3 Desktop backend: ${displayUrl.toString()}`);
    }
  }

  startServer(cli.port, {
    provider: cli.provider,
    t3Url,
    t3Token,
  });
}

main();
