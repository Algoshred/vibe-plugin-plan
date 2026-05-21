import { Elysia } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { PlanDispatcher } from "../lib/dispatcher.js";
import { SessionStore } from "../lib/session-store.js";

export function createHealthRoute(host: HostServices) {
  const dispatcher = new PlanDispatcher(host);
  const store = new SessionStore(host);

  return new Elysia().get("/health", async () => {
    const providers = dispatcher.list();
    const active = await store.list({ status: "active" });
    return {
      ok: true,
      providers: providers.length,
      activeSessions: active.length,
    };
  });
}
