import { DEFAULT_PORT } from "@claude-blocker/shared";

const KEEPALIVE_INTERVAL = 20_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;

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
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function getWebSocketUrl(): string {
  return `ws://localhost:${state.serverPort}/ws`;
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
        chrome.tabs.sendMessage(tab.id, { type: "STATE", ...publicState }).catch(() => {});
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
      state.serverConnected = false;
      stopKeepalive();
      broadcast();
      scheduleReconnect();
    };

    websocket.onerror = () => {
      state.serverConnected = false;
      stopKeepalive();
    };
  } catch {
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

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse(getPublicState());
    return true;
  }

  if (message.type === "ACTIVATE_BYPASS") {
    const today = new Date().toDateString();
    chrome.storage.sync.get(["lastBypassDate"], (result) => {
      if (result.lastBypassDate === today) {
        sendResponse({ success: false, reason: "Already used today" });
        return;
      }
      state.bypassUntil = Date.now() + 5 * 60 * 1000;
      chrome.storage.sync.set({ bypassUntil: state.bypassUntil, lastBypassDate: today });
      broadcast();
      sendResponse({ success: true });
    });
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

  if (message.type === "GET_BYPASS_STATUS") {
    const today = new Date().toDateString();
    chrome.storage.sync.get(["lastBypassDate"], (result) => {
      sendResponse({
        usedToday: result.lastBypassDate === today,
        bypassActive: state.bypassUntil !== null && state.bypassUntil > Date.now(),
        bypassUntil: state.bypassUntil,
      });
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

  connect();
});
