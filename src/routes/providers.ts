import { Elysia } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { PlanDispatcher } from "../lib/dispatcher.js";
import type { PlanErrorBody } from "../types.js";

function errorBody(error: string, code: PlanErrorBody["code"]): PlanErrorBody {
  return { error, code };
}

export function createProviderRoutes(host: HostServices) {
  const dispatcher = new PlanDispatcher(host);

  return new Elysia()
    .get("/providers", () => {
      const providers = dispatcher.list();
      return providers.map((entry) => {
        const provider = dispatcher.resolve(entry.name);
        return {
          name: entry.name,
          isDefault: entry.isDefault,
          capabilities: provider?.getCapabilities() ?? null,
        };
      });
    })
    .get("/providers/:name/capabilities", ({ params, set }) => {
      const provider = dispatcher.resolve(params.name);
      if (!provider) {
        set.status = 404;
        return errorBody(
          `No plan provider registered as '${params.name}'`,
          "PROVIDER_NOT_FOUND",
        );
      }
      return provider.getCapabilities();
    });
}
