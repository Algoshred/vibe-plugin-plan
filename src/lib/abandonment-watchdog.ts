/**
 * AbandonmentWatchdog — periodically scans the session store for active
 * sessions whose `updatedAt` is older than `MAX_ACTIVE_AGE_MS` and marks
 * them `abandoned`. Providers are independently responsible for killing
 * their own subprocesses on idle (e.g. plannotator's idle watchdog); this
 * watchdog handles the case where the provider itself crashed and the
 * session record stayed in `active` forever.
 */

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { SessionStore } from "./session-store.js";

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MAX_ACTIVE_AGE_MS = 4 * 60 * 60 * 1000; // 4 h

let timer: ReturnType<typeof setInterval> | null = null;

export function startAbandonmentWatchdog(host: HostServices): void {
  if (timer) return;
  const store = new SessionStore(host);

  const tick = async () => {
    try {
      const now = Date.now();
      const active = await store.list({ status: "active" });
      for (const session of active) {
        const updated = Date.parse(session.updatedAt);
        if (!Number.isFinite(updated)) continue;
        if (now - updated < MAX_ACTIVE_AGE_MS) continue;
        await store.patchStatus(session.id, "abandoned");
        host.telemetry?.emit("plan.session.abandoned", {
          sessionId: session.id,
          providerName: session.providerName,
          reason: "stale-active",
        });
      }
    } catch (error) {
      host.logger?.warn?.(
        "plan",
        "abandonment watchdog scan failed",
        toLogPayload(error),
      );
    }
  };

  timer = setInterval(() => {
    void tick();
  }, SCAN_INTERVAL_MS);
  // Run once on start to clean state from a prior unclean shutdown.
  void tick();
}

export function stopAbandonmentWatchdog(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function toLogPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}
