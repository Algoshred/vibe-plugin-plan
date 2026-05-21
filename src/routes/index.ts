/**
 * `/api/plan` route assembly.
 *
 * Combines /health, /providers, /sessions, /sessions/:id/feedback under
 * the plugin's API prefix. The agent's PluginManager mounts this Elysia
 * subapp via `app.use(createPlanRoutes(host))` on `onServerStart`.
 */

import { Elysia } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { createFeedbackRoutes } from "./feedback.js";
import { createHealthRoute } from "./health.js";
import { createProviderRoutes } from "./providers.js";
import { createSessionRoutes } from "./sessions.js";

export function createPlanRoutes(host: HostServices) {
  return new Elysia({ prefix: "/api/plan" })
    .use(createHealthRoute(host))
    .use(createProviderRoutes(host))
    .use(createSessionRoutes(host))
    .use(createFeedbackRoutes(host));
}
