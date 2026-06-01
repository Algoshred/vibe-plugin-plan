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
  provisionMetaProviders,
  TelemetryEmitter,
  type HostServices,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk";
import type { MetaProviderRef } from "@vibecontrols/plugin-sdk/contract";

import { createPlanRoutes } from "./routes/index.js";
import { createPlanBridgeRoute } from "./routes/plan-bridge.js";
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
const PLUGIN_VERSION = "2026.531.1";

/**
 * Provider packages this meta routes to + per-platform defaults. The meta —
 * not the agent — installs/loads/prereqs/elects them via `provisionProviders`.
 */
const PLAN_PROVIDERS: ReadonlyArray<MetaProviderRef> = [
  {
    packageName: "@vibecontrols/vibe-plugin-plan-plannotator",
    pluginName: "plan-plannotator",
  },
];

// Meta plugin extends the SDK contract with `publicPaths` (declared by the
// runtime, not yet on the SDK type) so the agent's edge-auth middleware
// treats `/plan/<sid>/*` as plugin-owned and lets it through unauthenticated
// for the iframe-bridge route to do its own auth (single-use HMAC ticket +
// scoped UI cookie + provider-key injection).
type PlanMetaVibePlugin = VibePlugin & { publicPaths?: string[] };

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

  const plugin: PlanMetaVibePlugin = {
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
    // Meta owns the generic `/plan/<sid>/*` iframe-bridge route. The agent's
    // edge auth must let it through unauthenticated — the bridge then
    // verifies a single-use HMAC ticket + scoped cookie itself before
    // forwarding to the active provider with the agent API key injected.
    publicPaths: ["/plan/"],
    metaProviders: PLAN_PROVIDERS,
    provisionProviders: (hostServices: HostServices) =>
      provisionMetaProviders(hostServices, PLAN_PROVIDERS),

    async onServerStart(app: unknown, host: HostServices) {
      await lifecycle.onServerStart(app, host);
      const elysiaApp = app as { use: (plugin: unknown) => unknown };
      elysiaApp.use(createPlanRoutes(host));
      // Mount the generic iframe-bridge BEFORE the active provider's own
      // routes register. Provider-agnostic: dispatches into the registered
      // PlanProvider via its `proxyRequest` method (see types.ts).
      elysiaApp.use(createPlanBridgeRoute(host));
      startAbandonmentWatchdog(host);
      process.stdout.write(
        "  Plugin 'plan' registered routes: /api/plan, /plan (bridge)\n",
      );
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
  return plugin;
};

export default createPlugin;
