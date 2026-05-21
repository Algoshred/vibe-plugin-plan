/**
 * PlanDispatcher — resolves a `PlanProvider` from the agent's
 * ServiceRegistry, either by explicit name or by the registry's default.
 *
 * The agent's `ServiceRegistry` (vibecontrols-agent/src/core/service-registry.ts)
 * exposes per-type provider lookup. The plan provider type is `"plan"`.
 * Until the agent's `ProviderType` enum widens to include `"plan"`, the
 * registry façade still accepts the string at runtime — the call is
 * structurally correct and only the agent's TypeScript union narrows it
 * out at compile time (in the agent's own codebase, not this plugin).
 */

import type { HostServices } from "@vibecontrols/plugin-sdk";

import type { PlanProvider } from "../types.js";

const PROVIDER_TYPE = "plan";

interface RegistrySurface {
  getProvider?<T>(type: string): T | undefined;
  getProviderByName?<T>(type: string, name: string): T | undefined;
  listProvidersForType?(
    type: string,
  ): string[] | Array<{ pluginName: string; isDefault: boolean }>;
}

function getRegistry(host: HostServices): RegistrySurface | null {
  // Prefer the typed serviceRegistry façade exposed by HostServices; fall
  // back to the older top-level `getProvider` shortcut for legacy hosts.
  const sr = host.serviceRegistry;
  if (sr) return sr as RegistrySurface;
  if (host.getProvider) {
    return { getProvider: host.getProvider.bind(host) };
  }
  return null;
}

export class PlanDispatcher {
  constructor(private readonly host: HostServices) {}

  /**
   * Resolve a specific provider by name. If `name` is falsy, return the
   * registry's default provider (last-registered fallback inside the
   * agent's ServiceRegistry).
   */
  resolve(name?: string): PlanProvider | null {
    const registry = getRegistry(this.host);
    if (!registry) return null;

    if (name && registry.getProviderByName) {
      const provider = registry.getProviderByName<PlanProvider>(
        PROVIDER_TYPE,
        name,
      );
      if (provider) return provider;
    }

    if (registry.getProvider) {
      const provider = registry.getProvider<PlanProvider>(PROVIDER_TYPE);
      if (provider) return provider;
    }

    return null;
  }

  /**
   * List provider names registered under the `plan` type. Tolerates both
   * the legacy `string[]` and the newer descriptor return shape of
   * `listProvidersForType()`.
   */
  list(): Array<{ name: string; isDefault: boolean }> {
    const registry = getRegistry(this.host);
    if (!registry?.listProvidersForType) return [];
    const result = registry.listProvidersForType(PROVIDER_TYPE);
    if (!result) return [];
    if (Array.isArray(result) && result.length === 0) return [];

    return (result as unknown[]).map((entry, index, all) => {
      if (typeof entry === "string") {
        return { name: entry, isDefault: index === all.length - 1 };
      }
      const descriptor = entry as { pluginName: string; isDefault: boolean };
      return {
        name: descriptor.pluginName,
        isDefault: descriptor.isDefault,
      };
    });
  }
}
