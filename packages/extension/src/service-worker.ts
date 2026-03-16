import { DEFAULT_PORT } from "@claude-blocker/shared";

const KEEPALIVE_INTERVAL = 20_000;
const STATUS_POLL_INTERVAL = 5_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
const DEFAULT_BYPASS_DURATION_MINUTES = 5;
const DEFAULT_BYPASS_MAX_UNLOCKS_PER_DAY = 1;
const MIN_BYPASS_DURATION_MINUTES = 1;
const MAX_BYPASS_DURATION_MINUTES = 180;
const MIN_BYPASS_MAX_UNLOCKS_PER_DAY = 1;
const MAX_BYPASS_MAX_UNLOCKS_PER_DAY = 20;

// The actual state - service worker is single source of truth
interface State {
  serverConnected: boolean;
  sessions: number;
  working: number;
  waitingForInput: number;
  bypassUntil: number | null;
  serverPort: number;
}

const state: State = {
  serverConnected: false,
  sessions: 0,
  working: 0,
  waitingForInput: 0,
  bypassUntil: null,
  serverPort: DEFAULT_PORT,
};

let websocket: WebSocket | null = null;
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
let statusPollInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function parseBypassDuration(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Math.min(MAX_BYPASS_DURATION_MINUTES, Math.max(MIN_BYPASS_DURATION_MINUTES, value));
  }
  return DEFAULT_BYPASS_DURATION_MINUTES;
}

function parseBypassMaxUnlocks(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Math.min(MAX_BYPASS_MAX_UNLOCKS_PER_DAY, Math.max(MIN_BYPASS_MAX_UNLOCKS_PER_DAY, value));
  }
  return DEFAULT_BYPASS_MAX_UNLOCKS_PER_DAY;
}

function parseBypassUsageCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return 0;
}

function todayKey(): string {
  return new Date().toDateString();
}

function getBypassStateFromStorage(
  result: Record<string, unknown>,
): {
  durationMinutes: number;
  maxUnlocksPerDay: number;
  usesToday: number;
} {
  const durationMinutes = parseBypassDuration(result.bypassDurationMinutes);
  const maxUnlocksPerDay = parseBypassMaxUnlocks(result.bypassMaxUnlocksPerDay);
  const usageDate = typeof result.bypassUsageDate === "string" ? result.bypassUsageDate : null;
  const usageCount = parseBypassUsageCount(result.bypassUsageCount);
  const legacyLastBypassDate =
    typeof result.lastBypassDate === "string" ? result.lastBypassDate : null;
  const today = todayKey();

  let usesToday = 0;
  if (usageDate === today) {
    usesToday = usageCount;
  } else if (legacyLastBypassDate === today) {
    usesToday = 1;
  }

  usesToday = Math.min(usesToday, maxUnlocksPerDay);

  return {
    durationMinutes,
    maxUnlocksPerDay,
    usesToday,
  };
}

function getWebSocketUrl(): string {
  // Use explicit IPv4 loopback because the server binds 127.0.0.1.
  // Firefox may resolve localhost to ::1 first, which causes false "offline" state.
  return `ws://127.0.0.1:${state.serverPort}/ws`;
}

function disconnectSocket(): void {
  if (!websocket) return;

  websocket.onopen = null;
  websocket.onmessage = null;
  websocket.onclose = null;
  websocket.onerror = null;
  websocket.close();
  websocket = null;
}

function reconnectNow(): void {
  state.serverConnected = false;
  stopKeepalive();

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  disconnectSocket();
  retryCount = 0;
  broadcast();
  void pollServerStatusOnce();
  connect();
}

// Compute derived state
function getPublicState() {
  const bypassActive = state.bypassUntil !== null && state.bypassUntil > Date.now();
  // Don't block if waiting for input - only block when truly idle
  const isIdle = state.working === 0 && state.waitingForInput === 0;
  const shouldBlock = !bypassActive && (isIdle || !state.serverConnected);

  return {
    serverConnected: state.serverConnected,
    sessions: state.sessions,
    working: state.working,
    waitingForInput: state.waitingForInput,
    blocked: shouldBlock,
    bypassActive,
    bypassUntil: state.bypassUntil,
    serverPort: state.serverPort,
  };
}

// Broadcast current state to all tabs
function broadcast() {
  const publicState = getPublicState();
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "STATE", ...publicState }, () => {
          // Ignore errors from tabs without content script (e.g. about:, chrome://)
          void chrome.runtime.lastError;
        });
      }
    }
  });
}

// WebSocket connection management
function connect() {
  if (websocket?.readyState === WebSocket.OPEN) return;
  if (websocket?.readyState === WebSocket.CONNECTING) return;

  try {
    websocket = new WebSocket(getWebSocketUrl());

    websocket.onopen = () => {
      console.log(`[Claude Blocker] Connected on port ${state.serverPort}`);
      state.serverConnected = true;
      retryCount = 0;
      startKeepalive();
      broadcast();
    };

    websocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "state") {
          state.sessions = msg.sessions;
          state.working = msg.working;
          state.waitingForInput = msg.waitingForInput ?? 0;
          broadcast();
        }
      } catch {}
    };

    websocket.onclose = () => {
      console.log(`[Claude Blocker] Disconnected from port ${state.serverPort}`);
      stopKeepalive();
      void pollServerStatusOnce();
      scheduleReconnect();
    };

    websocket.onerror = () => {
      stopKeepalive();
      void pollServerStatusOnce();
    };
  } catch {
    void pollServerStatusOnce();
    scheduleReconnect();
  }
}

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    if (websocket?.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "ping" }));
    }
  }, KEEPALIVE_INTERVAL);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), RECONNECT_MAX_DELAY);
  retryCount++;
  reconnectTimeout = setTimeout(connect, delay);
}

async function pollServerStatusOnce(): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.serverPort}/status`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    const payload = (await response.json()) as {
      sessions?: unknown;
      working?: unknown;
      waitingForInput?: unknown;
    };

    const sessions = Array.isArray(payload.sessions)
      ? payload.sessions.length
      : typeof payload.sessions === "number"
        ? payload.sessions
        : state.sessions;
    const working = typeof payload.working === "number" ? payload.working : state.working;
    const waitingForInput =
      typeof payload.waitingForInput === "number"
        ? payload.waitingForInput
        : state.waitingForInput;

    const changed =
      !state.serverConnected ||
      state.sessions !== sessions ||
      state.working !== working ||
      state.waitingForInput !== waitingForInput;

    state.serverConnected = true;
    state.sessions = sessions;
    state.working = working;
    state.waitingForInput = waitingForInput;

    if (changed) {
      broadcast();
    }
  } catch {
    const wsOpen = websocket?.readyState === WebSocket.OPEN;
    if (!wsOpen && state.serverConnected) {
      state.serverConnected = false;
      broadcast();
    }
  }
}

function startStatusPolling(): void {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
  }
  statusPollInterval = setInterval(() => {
    void pollServerStatusOnce();
  }, STATUS_POLL_INTERVAL);
  void pollServerStatusOnce();
}

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse(getPublicState());
    return true;
  }

  if (message.type === "REFRESH_STATE") {
    void pollServerStatusOnce().finally(() => {
      sendResponse(getPublicState());
    });
    return true;
  }

  if (message.type === "ACTIVATE_BYPASS") {
    chrome.storage.sync.get(
      [
        "bypassDurationMinutes",
        "bypassMaxUnlocksPerDay",
        "bypassUsageDate",
        "bypassUsageCount",
        "lastBypassDate",
      ],
      (result) => {
        const { durationMinutes, maxUnlocksPerDay, usesToday } = getBypassStateFromStorage(result);
        if (usesToday >= maxUnlocksPerDay) {
          sendResponse({ success: false, reason: "No unlocks left today" });
          return;
        }

        const nextUsesToday = usesToday + 1;
        const nextBypassUntil = Date.now() + durationMinutes * 60 * 1000;
        state.bypassUntil = nextBypassUntil;

        chrome.storage.sync.set(
          {
            bypassUntil: nextBypassUntil,
            bypassUsageDate: todayKey(),
            bypassUsageCount: nextUsesToday,
            // Keep legacy key populated for backward compatibility.
            lastBypassDate: todayKey(),
          },
          () => {
            broadcast();
            sendResponse({
              success: true,
              bypassUntil: nextBypassUntil,
              usesToday: nextUsesToday,
              remainingUses: maxUnlocksPerDay - nextUsesToday,
              maxUnlocksPerDay,
              durationMinutes,
            });
          },
        );
      },
    );
    return true;
  }

  if (message.type === "SET_BYPASS_SETTINGS") {
    const requestedDuration = Number(message.durationMinutes);
    const requestedMaxUnlocks = Number(message.maxUnlocksPerDay);

    if (
      !Number.isInteger(requestedDuration) ||
      requestedDuration < MIN_BYPASS_DURATION_MINUTES ||
      requestedDuration > MAX_BYPASS_DURATION_MINUTES
    ) {
      sendResponse({
        success: false,
        reason: `Duration must be ${MIN_BYPASS_DURATION_MINUTES}-${MAX_BYPASS_DURATION_MINUTES} minutes`,
      });
      return true;
    }

    if (
      !Number.isInteger(requestedMaxUnlocks) ||
      requestedMaxUnlocks < MIN_BYPASS_MAX_UNLOCKS_PER_DAY ||
      requestedMaxUnlocks > MAX_BYPASS_MAX_UNLOCKS_PER_DAY
    ) {
      sendResponse({
        success: false,
        reason: `Unlocks/day must be ${MIN_BYPASS_MAX_UNLOCKS_PER_DAY}-${MAX_BYPASS_MAX_UNLOCKS_PER_DAY}`,
      });
      return true;
    }

    chrome.storage.sync.set(
      {
        bypassDurationMinutes: requestedDuration,
        bypassMaxUnlocksPerDay: requestedMaxUnlocks,
      },
      () => {
        sendResponse({
          success: true,
          durationMinutes: requestedDuration,
          maxUnlocksPerDay: requestedMaxUnlocks,
        });
      },
    );
    return true;
  }

  if (message.type === "GET_BYPASS_STATUS") {
    chrome.storage.sync.get(
      [
        "bypassDurationMinutes",
        "bypassMaxUnlocksPerDay",
        "bypassUsageDate",
        "bypassUsageCount",
        "lastBypassDate",
      ],
      (result) => {
        const { durationMinutes, maxUnlocksPerDay, usesToday } = getBypassStateFromStorage(result);
        const remainingUses = Math.max(0, maxUnlocksPerDay - usesToday);

        sendResponse({
          usedToday: usesToday > 0,
          usesToday,
          remainingUses,
          maxUnlocksPerDay,
          durationMinutes,
          bypassActive: state.bypassUntil !== null && state.bypassUntil > Date.now(),
          bypassUntil: state.bypassUntil,
        });
      },
    );
    return true;
  }

  if (message.type === "SET_SERVER_PORT") {
    const nextPort = Number(message.port);
    if (!isValidPort(nextPort)) {
      sendResponse({ success: false, reason: "Invalid port" });
      return true;
    }

    if (nextPort === state.serverPort) {
      sendResponse({ success: true });
      return true;
    }

    state.serverPort = nextPort;
    chrome.storage.sync.set({ serverPort: nextPort }, () => {
      reconnectNow();
      sendResponse({ success: true });
    });

    return true;
  }

  return false;
});

// Keep service worker synced if storage changes elsewhere
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  const changedPort = changes.serverPort?.newValue;
  if (isValidPort(changedPort) && changedPort !== state.serverPort) {
    state.serverPort = changedPort;
    reconnectNow();
  }
});

// Check bypass expiry
setInterval(() => {
  if (state.bypassUntil && state.bypassUntil <= Date.now()) {
    state.bypassUntil = null;
    chrome.storage.sync.remove("bypassUntil");
    broadcast();
  }
}, 5000);

// Start
chrome.storage.sync.get(["bypassUntil", "serverPort"], (result) => {
  if (typeof result.bypassUntil === "number" && result.bypassUntil > Date.now()) {
    state.bypassUntil = result.bypassUntil;
  }

  if (isValidPort(result.serverPort)) {
    state.serverPort = result.serverPort;
  }

  startStatusPolling();
  connect();
});
