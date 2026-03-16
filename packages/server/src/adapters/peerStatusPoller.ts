interface PeerUpdate {
  reachable: boolean;
  sessions: number;
  working: number;
  waitingForInput: number;
  lastError: string | null;
  lastSeenAt: string | null;
}

interface PeerStatusPollerOptions {
  urls: string[];
  refreshMs: number;
  onUpdate: (url: string, update: PeerUpdate) => void;
}

const FETCH_TIMEOUT_MS = 3_000;

function parseRemoteCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function toPeerError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Peer status request failed";
}

export class PeerStatusPoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly options: PeerStatusPollerOptions) {}

  start(): void {
    this.stopped = false;
    void this.pollAll();
    this.interval = setInterval(() => {
      void this.pollAll();
    }, this.options.refreshMs);
    this.interval.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async pollAll(): Promise<void> {
    await Promise.all(this.options.urls.map((url) => this.pollOne(url)));
  }

  private async pollOne(url: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        sessions?: unknown;
        working?: unknown;
        waitingForInput?: unknown;
      };

      const sessions = Array.isArray(payload.sessions)
        ? payload.sessions.length
        : parseRemoteCount(payload.sessions);
      const working = parseRemoteCount(payload.working);
      const waitingForInput = parseRemoteCount(payload.waitingForInput);

      if (this.stopped) {
        return;
      }
      this.options.onUpdate(url, {
        reachable: true,
        sessions,
        working,
        waitingForInput,
        lastError: null,
        lastSeenAt: new Date().toISOString(),
      });
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.options.onUpdate(url, {
        reachable: false,
        sessions: 0,
        working: 0,
        waitingForInput: 0,
        lastError: toPeerError(error),
        lastSeenAt: null,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

