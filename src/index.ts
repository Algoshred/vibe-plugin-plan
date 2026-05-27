/**
 * @vibecontrols/vibe-plugin-plan
 *
 * Plan orchestration meta-plugin. Owns the PlanProvider contract and the
 * `/api/plan/*` REST surface. Providers (e.g. vibe-plugin-plan-plannotator)
 * register themselves with the agent's ServiceRegistry under the `"plan"`
 * provider type; this plugin resolves them via PlanDispatcher and exposes
 * a uniform REST + CLI surface.
 *
 * Manifest:
 *   apiPrefix:   /api/plan
 *   cliCommand:  plan
 *   capabilities: storage rw, telemetry, broadcast
 *   tags:        backend, provider
 *   hasUI:       false (UI lives in the provider + microfe)
 *
 * Companion provider: @vibecontrols/vibe-plugin-plan-plannotator
 */

import type { Command } from "commander";

import {
  createLifecycleHooks,
  TelemetryEmitter,
  type HostServices,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk";

import { createPlanRoutes } from "./routes/index.js";
import { registerPlanCommands } from "./commands.js";
import {
  startAbandonmentWatchdog,
  stopAbandonmentWatchdog,
} from "./lib/abandonment-watchdog.js";

export type {
  PlanProvider,
  PlanProviderCapabilities,
  PlanSession,
  PlanSessionStatus,
  PlanFeedback,
  PlanContent,
  PlanAnnotation,
  PlanMode,
  StartSessionRequest,
  ListSessionsFilter,
  PlanErrorBody,
  PlanErrorCode,
} from "./types.js";

const PLUGIN_NAME = "plan";
const PLUGIN_VERSION = "2026.527.1";

export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "plan.meta.ready",
    onInit: async (host: HostServices) => {
      const telemetry = new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION, host);
      telemetry.emitEvent("plan.meta.ready", {});
    },
  });

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Plan orchestration hub — dispatches to a registered PlanProvider",
    tags: ["backend", "provider"],
    capabilities: {
      storage: "rw",
      telemetry: true,
      broadcast: true,
    },
    cliCommand: "plan",
    apiPrefix: "/api/plan",

    async onServerStart(app: unknown, host: HostServices) {
      await lifecycle.onServerStart(app, host);
      const elysiaApp = app as { use: (plugin: unknown) => unknown };
      elysiaApp.use(createPlanRoutes(host));
      startAbandonmentWatchdog(host);
      process.stdout.write("  Plugin 'plan' registered routes: /api/plan\n");
    },

    async onServerStop(host: HostServices) {
      stopAbandonmentWatchdog();
      await lifecycle.onServerStop(host);
      process.stdout.write("  Plugin 'plan' stopped\n");
    },

    onCliSetup(programArg: unknown) {
      registerPlanCommands(programArg as Command);
    },
  };
};

export default createPlugin;
