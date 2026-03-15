import { DEFAULT_BLOCKED_DOMAINS, DEFAULT_PORT } from "@claude-blocker/shared";

interface ExtensionState {
  blocked: boolean;
  serverConnected: boolean;
  sessions: number;
  working: number;
  bypassActive: boolean;
  serverPort: number;
}

interface BypassStatus {
  usedToday: boolean;
  usesToday: number;
  remainingUses: number;
  maxUnlocksPerDay: number;
  durationMinutes: number;
  bypassActive: boolean;
  bypassUntil: number | null;
}

// Elements
const statusIndicator = document.getElementById("status-indicator") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const sessionsEl = document.getElementById("sessions") as HTMLElement;
const workingEl = document.getElementById("working") as HTMLElement;
const blockStatusEl = document.getElementById("block-status") as HTMLElement;
const addForm = document.getElementById("add-form") as HTMLFormElement;
const domainInput = document.getElementById("domain-input") as HTMLInputElement;
const domainList = document.getElementById("domain-list") as HTMLUListElement;
const siteCount = document.getElementById("site-count") as HTMLElement;
const bypassBtn = document.getElementById("bypass-btn") as HTMLButtonElement;
const bypassText = document.getElementById("bypass-text") as HTMLElement;
const bypassStatus = document.getElementById("bypass-status") as HTMLElement;
const bypassSettingsForm = document.getElementById("bypass-settings-form") as HTMLFormElement;
const bypassMaxUnlocksInput = document.getElementById("bypass-max-unlocks-input") as HTMLInputElement;
const bypassDurationInput = document.getElementById("bypass-duration-input") as HTMLInputElement;
const bypassSettingsStatus = document.getElementById("bypass-settings-status") as HTMLElement;
const serverPortForm = document.getElementById("server-port-form") as HTMLFormElement;
const serverPortInput = document.getElementById("server-port-input") as HTMLInputElement;
const serverPortStatus = document.getElementById("server-port-status") as HTMLElement;

let bypassCountdown: ReturnType<typeof setInterval> | null = null;
let currentDomains: string[] = [];

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function isValidBypassMaxUnlocks(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 20;
}

function isValidBypassDuration(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 180;
}

// Load domains from storage
async function loadDomains(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["blockedDomains"], (result) => {
      if (result.blockedDomains && Array.isArray(result.blockedDomains)) {
        resolve(result.blockedDomains);
      } else {
        chrome.storage.sync.set({ blockedDomains: DEFAULT_BLOCKED_DOMAINS });
        resolve(DEFAULT_BLOCKED_DOMAINS);
      }
    });
  });
}

// Save domains to storage
async function saveDomains(domains: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ blockedDomains: domains }, () => {
      // Notify all tabs about the change
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: "DOMAINS_UPDATED", domains }, () => {
              void chrome.runtime.lastError;
            });
          }
        }
      });
      resolve();
    });
  });
}

// Normalize domain input
function normalizeDomain(input: string): string {
  let domain = input.toLowerCase().trim();
  domain = domain.replace(/^https?:\/\//, "");
  domain = domain.replace(/^www\./, "");
  domain = domain.replace(/\/.*$/, "");
  return domain;
}

// Validate domain format
function isValidDomain(domain: string): boolean {
  const regex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
  return regex.test(domain);
}

function setServerPortStatus(message: string, isError = false): void {
  serverPortStatus.textContent = message;
  serverPortStatus.style.color = isError ? "var(--accent-red)" : "var(--text-dim)";
}

function setBypassSettingsStatus(message: string, isError = false): void {
  bypassSettingsStatus.textContent = message;
  bypassSettingsStatus.style.color = isError ? "var(--accent-red)" : "var(--text-dim)";
}

function updateServerPort(port: number): void {
  chrome.runtime.sendMessage({ type: "SET_SERVER_PORT", port }, (response) => {
    if (response?.success) {
      setServerPortStatus(`Using 127.0.0.1:${port}`);
      refreshState();
      return;
    }

    setServerPortStatus(response?.reason ?? "Failed to update port", true);
  });
}

function updateBypassSettings(maxUnlocksPerDay: number, durationMinutes: number): void {
  chrome.runtime.sendMessage(
    {
      type: "SET_BYPASS_SETTINGS",
      maxUnlocksPerDay,
      durationMinutes,
    },
    (response) => {
      if (response?.success) {
        setBypassSettingsStatus(
          `Saved: ${maxUnlocksPerDay} unlock${maxUnlocksPerDay === 1 ? "" : "s"}/day, ${durationMinutes} min each`,
        );
        refreshState();
        return;
      }

      setBypassSettingsStatus(response?.reason ?? "Failed to save bypass settings", true);
    },
  );
}

// Render the domain list
function renderDomains(): void {
  domainList.innerHTML = "";
  siteCount.textContent = String(currentDomains.length);

  if (currentDomains.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    domainList.appendChild(empty);
    return;
  }

  for (const domain of currentDomains) {
    const li = document.createElement("li");
    li.className = "domain-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "domain-name";
    nameSpan.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.title = "Remove site";
    removeBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `;
    removeBtn.addEventListener("click", () => removeDomain(domain));

    li.appendChild(nameSpan);
    li.appendChild(removeBtn);
    domainList.appendChild(li);
  }
}

// Add a domain
async function addDomain(raw: string): Promise<void> {
  const domain = normalizeDomain(raw);

  if (!domain) return;

  if (!isValidDomain(domain)) {
    domainInput.classList.add("error");
    setTimeout(() => domainInput.classList.remove("error"), 400);
    return;
  }

  if (currentDomains.includes(domain)) {
    domainInput.value = "";
    return;
  }

  currentDomains.push(domain);
  currentDomains.sort();
  await saveDomains(currentDomains);
  renderDomains();
  domainInput.value = "";
}

// Remove a domain
async function removeDomain(domain: string): Promise<void> {
  currentDomains = currentDomains.filter((d) => d !== domain);
  await saveDomains(currentDomains);
  renderDomains();
}

// Update UI with extension state
function updateUI(state: ExtensionState): void {
  // Status badge
  if (!state.serverConnected) {
    statusIndicator.className = "status-indicator disconnected";
    statusText.textContent = "Offline";
  } else if (state.working > 0) {
    statusIndicator.className = "status-indicator working";
    statusText.textContent = "Claude Working";
  } else {
    statusIndicator.className = "status-indicator connected";
    statusText.textContent = "Connected";
  }

  // Stats
  sessionsEl.textContent = String(state.sessions);
  workingEl.textContent = String(state.working);

  // Block status
  if (state.bypassActive) {
    blockStatusEl.textContent = "Bypassed";
    blockStatusEl.style.color = "var(--accent-amber)";
  } else if (state.blocked) {
    blockStatusEl.textContent = "Blocking";
    blockStatusEl.style.color = "var(--accent-red)";
  } else {
    blockStatusEl.textContent = "Open";
    blockStatusEl.style.color = "var(--accent-green)";
  }

  if (document.activeElement !== serverPortInput) {
    serverPortInput.value = String(state.serverPort ?? DEFAULT_PORT);
  }
}

// Update bypass button state
function updateBypassButton(status: BypassStatus): void {
  if (bypassCountdown) {
    clearInterval(bypassCountdown);
    bypassCountdown = null;
  }

  if (status.bypassActive && status.bypassUntil) {
    bypassBtn.disabled = true;
    bypassBtn.classList.add("active");

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((status.bypassUntil! - Date.now()) / 1000));
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      bypassText.textContent = `Bypass Active · ${minutes}:${seconds.toString().padStart(2, "0")}`;

      if (remaining <= 0) {
        if (bypassCountdown) clearInterval(bypassCountdown);
        refreshState();
      }
    };

    updateCountdown();
    bypassCountdown = setInterval(updateCountdown, 1000);
    bypassStatus.textContent = `${status.remainingUses} of ${status.maxUnlocksPerDay} unlocks left today`;
  } else if (status.remainingUses <= 0) {
    bypassBtn.disabled = true;
    bypassBtn.classList.remove("active");
    bypassText.textContent = "No Unlocks Left Today";
    bypassStatus.textContent = `Used ${status.usesToday}/${status.maxUnlocksPerDay} today · resets at midnight`;
  } else {
    bypassBtn.disabled = false;
    bypassBtn.classList.remove("active");
    bypassText.textContent = `Activate ${status.durationMinutes}m Unlock`;
    bypassStatus.textContent = `${status.remainingUses} of ${status.maxUnlocksPerDay} unlocks left today`;
  }
}

// Refresh state from service worker
function refreshState(): void {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state: ExtensionState) => {
    if (state) {
      updateUI(state);
      setServerPortStatus(`Using 127.0.0.1:${state.serverPort ?? DEFAULT_PORT}`);
    }
  });

  chrome.runtime.sendMessage({ type: "GET_BYPASS_STATUS" }, (status: BypassStatus) => {
    if (status) {
      if (document.activeElement !== bypassMaxUnlocksInput) {
        bypassMaxUnlocksInput.value = String(status.maxUnlocksPerDay);
      }
      if (document.activeElement !== bypassDurationInput) {
        bypassDurationInput.value = String(status.durationMinutes);
      }
      setBypassSettingsStatus(
        `Current: ${status.maxUnlocksPerDay} unlock${status.maxUnlocksPerDay === 1 ? "" : "s"}/day, ${status.durationMinutes} min each`,
      );
      updateBypassButton(status);
    }
  });
}

// Event listeners
serverPortForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = Number(serverPortInput.value);
  if (!isValidPort(parsed)) {
    setServerPortStatus("Enter a valid port between 1 and 65535", true);
    serverPortInput.classList.add("error");
    setTimeout(() => serverPortInput.classList.remove("error"), 400);
    return;
  }

  updateServerPort(parsed);
});

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  addDomain(domainInput.value);
});

bypassSettingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const maxUnlocksPerDay = Number(bypassMaxUnlocksInput.value);
  const durationMinutes = Number(bypassDurationInput.value);

  if (!isValidBypassMaxUnlocks(maxUnlocksPerDay)) {
    setBypassSettingsStatus("Unlocks per day must be between 1 and 20", true);
    bypassMaxUnlocksInput.classList.add("error");
    setTimeout(() => bypassMaxUnlocksInput.classList.remove("error"), 400);
    return;
  }

  if (!isValidBypassDuration(durationMinutes)) {
    setBypassSettingsStatus("Unlock duration must be between 1 and 180 minutes", true);
    bypassDurationInput.classList.add("error");
    setTimeout(() => bypassDurationInput.classList.remove("error"), 400);
    return;
  }

  updateBypassSettings(maxUnlocksPerDay, durationMinutes);
});

bypassBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ACTIVATE_BYPASS" }, (response) => {
    if (response?.success) {
      refreshState();
    } else if (response?.reason) {
      bypassStatus.textContent = response.reason;
    }
  });
});

// Listen for state broadcasts
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") {
    updateUI(message);
  }
});

// Initialize
async function init(): Promise<void> {
  currentDomains = await loadDomains();
  renderDomains();
  setServerPortStatus(`Using 127.0.0.1:${DEFAULT_PORT}`);
  refreshState();
}

init();

// Refresh periodically
setInterval(refreshState, 5000);
