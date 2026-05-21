import { describe, expect, it } from "bun:test";

import { PlanDispatcher } from "../src/lib/dispatcher.js";
import type {
  PlanProvider,
  PlanProviderCapabilities,
  PlanSession,
} from "../src/types.js";

function makeProvider(name: string): PlanProvider {
  const capabilities: PlanProviderCapabilities = {
    modes: ["plan"],
    supportsStreaming: false,
    supportsVersionHistory: false,
    supportsAnnotations: false,
    supportsArchive: false,
    externallyHosted: false,
  };
  return {
    name,
    getCapabilities: () => capabilities,
    startSession: async (): Promise<PlanSession> => ({
      id: "x",
      providerName: name,
      projectId: "p",
      status: "active",
      mode: "plan",
      createdAt: "",
      updatedAt: "",
    }),
    getSession: async () => null,
    listSessions: async () => [],
    submitFeedback: async (): Promise<PlanSession> => ({
      id: "x",
      providerName: name,
      projectId: "p",
      status: "approved",
      mode: "plan",
      createdAt: "",
      updatedAt: "",
    }),
    endSession: async () => undefined,
  };
}

interface RegistrySurface {
  getProvider<T>(type: string): T | undefined;
  getProviderByName<T>(type: string, name: string): T | undefined;
  listProvidersForType(
    type: string,
  ): Array<{ pluginName: string; isDefault: boolean }>;
}

function makeRegistry(
  providers: Record<string, PlanProvider>,
  defaultName?: string,
): RegistrySurface {
  return {
    getProvider<T>(type: string): T | undefined {
      if (type !== "plan") return undefined;
      const target = defaultName ?? Object.keys(providers).at(-1);
      if (!target) return undefined;
      return providers[target] as T;
    },
    getProviderByName<T>(type: string, name: string): T | undefined {
      if (type !== "plan") return undefined;
      return providers[name] as T | undefined;
    },
    listProvidersForType(type: string) {
      if (type !== "plan") return [];
      return Object.keys(providers).map((n) => ({
        pluginName: n,
        isDefault: n === (defaultName ?? Object.keys(providers).at(-1)),
      }));
    },
  };
}

describe("PlanDispatcher", () => {
  it("resolves by explicit name", () => {
    const dispatcher = new PlanDispatcher({
      serviceRegistry: makeRegistry({
        plannotator: makeProvider("plannotator"),
        custom: makeProvider("custom"),
      }),
    });
    expect(dispatcher.resolve("custom")?.name).toBe("custom");
  });

  it("falls back to registry default when no name given", () => {
    const dispatcher = new PlanDispatcher({
      serviceRegistry: makeRegistry(
        {
          a: makeProvider("a"),
          b: makeProvider("b"),
        },
        "b",
      ),
    });
    expect(dispatcher.resolve()?.name).toBe("b");
  });

  it("returns null when registry has no providers", () => {
    const dispatcher = new PlanDispatcher({
      serviceRegistry: makeRegistry({}),
    });
    expect(dispatcher.resolve()).toBeNull();
  });

  it("returns null when registry is missing", () => {
    const dispatcher = new PlanDispatcher({});
    expect(dispatcher.resolve()).toBeNull();
  });

  it("lists registered providers with default flag", () => {
    const dispatcher = new PlanDispatcher({
      serviceRegistry: makeRegistry(
        {
          alpha: makeProvider("alpha"),
          beta: makeProvider("beta"),
        },
        "beta",
      ),
    });
    const result = dispatcher.list();
    expect(result.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "alpha", isDefault: false },
      { name: "beta", isDefault: true },
    ]);
  });
});
