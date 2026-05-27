import { describe, expect, it } from "bun:test";

import { SessionStore } from "../src/lib/session-store.js";
import type { PlanSession } from "../src/types.js";

interface StorageBackend {
  get<T>(ns: string, key: string): Promise<T | null>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
  delete(ns: string, key: string): Promise<boolean>;
  list(ns: string): Promise<string[]>;
}

function makeMemoryStorage(): StorageBackend {
  const data = new Map<string, unknown>();
  const key = (ns: string, k: string) => `${ns}::${k}`;
  return {
    async get<T>(ns: string, k: string): Promise<T | null> {
      return (data.get(key(ns, k)) as T | undefined) ?? null;
    },
    async set<T>(ns: string, k: string, v: T): Promise<void> {
      data.set(key(ns, k), v);
    },
    async delete(ns: string, k: string): Promise<boolean> {
      return data.delete(key(ns, k));
    },
    async list(ns: string): Promise<string[]> {
      const prefix = `${ns}::`;
      return [...data.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}

// Mimics the skalex adapter: rejects non-string values (the agent's default
// storage requires string values), so an object passed to set() throws.
function makeStringOnlyStorage(): StorageBackend {
  const data = new Map<string, string>();
  const key = (ns: string, k: string) => `${ns}::${k}`;
  return {
    async get<T>(ns: string, k: string): Promise<T | null> {
      return (data.get(key(ns, k)) as T | undefined) ?? null;
    },
    async set<T>(ns: string, k: string, v: T): Promise<void> {
      if (typeof v !== "string") {
        throw new Error(
          `Validation failed: Field "value" must be of type "string", got "${typeof v}"`,
        );
      }
      data.set(key(ns, k), v);
    },
    async delete(ns: string, k: string): Promise<boolean> {
      return data.delete(key(ns, k));
    },
    async list(ns: string): Promise<string[]> {
      const prefix = `${ns}::`;
      return [...data.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}

function makeSession(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    id: "sess-1",
    providerName: "plannotator",
    projectId: "proj-1",
    status: "active",
    mode: "plan",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("SessionStore", () => {
  it("saves and reads a session", async () => {
    const store = new SessionStore({ storage: makeMemoryStorage() });
    await store.save(makeSession({ id: "a" }));
    const read = await store.get("a");
    expect(read?.id).toBe("a");
    expect(read?.status).toBe("active");
  });

  it("returns null for missing sessions", async () => {
    const store = new SessionStore({ storage: makeMemoryStorage() });
    const result = await store.get("does-not-exist");
    expect(result).toBeNull();
  });

  it("filters list() by status and provider", async () => {
    const store = new SessionStore({ storage: makeMemoryStorage() });
    await store.save(makeSession({ id: "a", status: "active" }));
    await store.save(
      makeSession({ id: "b", status: "approved", providerName: "other" }),
    );
    await store.save(makeSession({ id: "c", status: "active" }));

    const active = await store.list({ status: "active" });
    expect(active.map((s) => s.id).sort()).toEqual(["a", "c"]);

    const approved = await store.list({ status: "approved" });
    expect(approved.map((s) => s.id)).toEqual(["b"]);

    const other = await store.list({ provider: "other" });
    expect(other.map((s) => s.id)).toEqual(["b"]);
  });

  it("patchStatus updates terminal fields", async () => {
    const store = new SessionStore({ storage: makeMemoryStorage() });
    await store.save(makeSession({ id: "a", status: "active" }));

    const result = await store.patchStatus("a", "approved");
    expect(result?.status).toBe("approved");
    expect(result?.endedAt).toBeTruthy();

    const reloaded = await store.get("a");
    expect(reloaded?.status).toBe("approved");
  });

  it("delete removes the entry", async () => {
    const store = new SessionStore({ storage: makeMemoryStorage() });
    await store.save(makeSession({ id: "a" }));
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });

  it("round-trips through a string-only storage adapter (skalex)", async () => {
    // Regression: save() used to pass the raw object → skalex rejected it with
    // "Field value must be of type string, got object", 500-ing POST /sessions
    // after plannotator had already spawned.
    const store = new SessionStore({ storage: makeStringOnlyStorage() });
    await store.save(makeSession({ id: "a", projectId: "proj-x" }));
    const read = await store.get("a");
    expect(read?.id).toBe("a");
    expect(read?.projectId).toBe("proj-x");
    expect(read?.status).toBe("active");
  });

  it("get() returns null on malformed stored JSON", async () => {
    const storage = makeStringOnlyStorage();
    await storage.set("plans", "bad", "{not json");
    const store = new SessionStore({ storage });
    expect(await store.get("bad")).toBeNull();
  });
});
