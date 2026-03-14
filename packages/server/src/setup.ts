import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DEFAULT_PORT } from "./types.js";

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookRule[]>;
  [key: string]: unknown;
}

interface ClaudeHookRule {
  matcher?: string;
  hooks?: Array<{
    type?: string;
    command?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
  "SessionStart",
  "SessionEnd",
] as const;

function createHookCommand(port: number): string {
  return `curl -s -X POST http://localhost:${port}/hook -H 'Content-Type: application/json' -d "$(cat)" > /dev/null 2>&1 &`;
}

function isClaudeBlockerCommand(command: string): boolean {
  return /http:\/\/localhost:\d+\/hook/.test(command);
}

function createHooksConfig(port: number): Record<(typeof HOOK_EVENTS)[number], ClaudeHookRule[]> {
  const command = createHookCommand(port);
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command,
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command,
          },
        ],
      },
    ],
  };
}

function stripClaudeBlockerHooks(rule: ClaudeHookRule): ClaudeHookRule | null {
  if (!Array.isArray(rule.hooks)) {
    return rule;
  }

  const hooks = rule.hooks.filter(
    (hook) => !(hook.type === "command" && typeof hook.command === "string" && isClaudeBlockerCommand(hook.command))
  );

  if (hooks.length === 0) {
    return null;
  }

  return {
    ...rule,
    hooks,
  };
}

export function setupHooks(port: number = DEFAULT_PORT): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const hooksConfig = createHooksConfig(port);

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    console.log(`Created ${claudeDir}`);
  }

  // Load existing settings or create empty object
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
      console.log("Loaded existing settings.json");
    } catch (error) {
      console.error("Error reading settings.json:", error);
      console.log("Creating new settings.json");
    }
  }

  // Merge hooks while preserving existing non-Claude Blocker commands
  settings.hooks ??= {};
  for (const hookName of HOOK_EVENTS) {
    const existing = Array.isArray(settings.hooks[hookName]) ? settings.hooks[hookName] : [];
    const preserved = existing
      .map(stripClaudeBlockerHooks)
      .filter((rule): rule is ClaudeHookRule => rule !== null);
    settings.hooks[hookName] = [...preserved, ...hooksConfig[hookName]];
  }

  // Write settings
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  console.log(`
┌─────────────────────────────────────────────────┐
│                                                 │
│   Claude Blocker Setup Complete!                │
│                                                 │
│   Hook target port: ${port}
│                                                 │
│   Hooks configured in:                          │
│   ${settingsPath}
│                                                 │
│   Configured hooks:                             │
│   - UserPromptSubmit (work starting)            │
│   - PreToolUse (tool executing)                 │
│   - Stop (work finished)                        │
│   - SessionStart (session began)                │
│   - SessionEnd (session ended)                  │
│                                                 │
│   Next: Run 'npx claude-blocker' to start       │
│                                                 │
└─────────────────────────────────────────────────┘
`);
}

export function areHooksConfigured(port: number = DEFAULT_PORT): boolean {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    return false;
  }

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings: ClaudeSettings = JSON.parse(content);

    if (!settings.hooks) {
      return false;
    }

    const expectedTarget = `http://localhost:${port}/hook`;
    return HOOK_EVENTS.every((hookName) => {
      const rules = settings.hooks?.[hookName];
      if (!Array.isArray(rules)) {
        return false;
      }

      return rules.some((rule) =>
        Array.isArray(rule.hooks) &&
        rule.hooks.some(
          (hook) =>
            hook.type === "command" &&
            typeof hook.command === "string" &&
            hook.command.includes(expectedTarget)
        )
      );
    });
  } catch {
    return false;
  }
}

export function removeHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    console.log("No settings.json found, nothing to remove.");
    return;
  }

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings: ClaudeSettings = JSON.parse(content);

    if (settings.hooks) {
      // Remove our hooks
      for (const hookName of HOOK_EVENTS) {
        const rules = settings.hooks[hookName];
        if (!Array.isArray(rules)) {
          continue;
        }

        const filtered = rules
          .map(stripClaudeBlockerHooks)
          .filter((rule): rule is ClaudeHookRule => rule !== null);

        if (filtered.length === 0) {
          delete settings.hooks[hookName];
        } else {
          settings.hooks[hookName] = filtered;
        }
      }

      // If hooks object is empty, remove it entirely
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log("Claude Blocker hooks removed from settings.json");
    } else {
      console.log("No hooks found in settings.json");
    }
  } catch (error) {
    console.error("Error removing hooks:", error);
  }
}
