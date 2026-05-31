/**
 * `/plan/<sid>/*` iframe-ticket -> cookie bridge route.
 *
 * Mounted on the agent's plugin router by the meta plugin's
 * `onServerStart`. The agent's top-level `/plan/*` route is a blind
 * `pluginRoutesApp.handle(request)` delegator and never knows about a
 * specific plan provider - this route is the seam where the host's
 * iframe-bridge primitives (`HostServices.iframeBridge`) meet the
 * provider's reverse proxy (`PlanProvider.proxyRequest`).
 *
 * Lives under `/plan/<sid>/*`, NOT `/api/plan/*` - it's the user-facing
 * tunnel iframe surface, declared as a public path on the meta plugin's
 * manifest so the agent's edge auth lets it through unauthenticated
 * (the bridge does its own auth).
 */

import { Elysia } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import {
  createProviderForwarder,
  handlePlanProxyRequest,
} from "../lib/iframe-bridge.js";

export function createPlanBridgeRoute(host: HostServices) {
  const forwarder = createProviderForwarder(host);
  return new Elysia({ prefix: "/plan" }).all("/*", async ({ request }) =>
    handlePlanProxyRequest(request, host, forwarder),
  );
}
