import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Elysia } from "elysia";

import { createPlanRoutes } from "../src/routes/index.js";
import { normalizeStartRequest } from "../src/routes/sessions.js";
import type {
  PlanProvider,
  PlanProviderCapabilities,
  PlanSession,
} from "../src/types.js";

function makeMemoryStorage() {
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

function makeProvider(): PlanProvider {
  const capabilities: PlanProviderCapabilities = {
    modes: ["plan", "review"],
    supportsStreaming: false,
    supportsVersionHistory: true,
    supportsAnnotations: true,
    supportsArchive: false,
    externallyHosted: false,
  };
  return {
    name: "stub",
    getCapabilities: () => capabilities,
    startSession: async (req): Promise<PlanSession> => ({
      id: "provider-session-1",
      providerName: "stub",
      projectId: req.projectId,
      status: "active",
      mode: req.mode ?? "plan",
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
      uiUrl: "/plan/provider-session-1/",
    }),
    getSession: async (id) => ({
      id,
      providerName: "stub",
      projectId: "p",
      status: "active",
      mode: "plan",
      createdAt: "",
      updatedAt: "",
      content: { markdown: "# hello" },
    }),
    listSessions: async () => [],
    submitFeedback: async (id, feedback): Promise<PlanSession> => ({
      id,
      providerName: "stub",
      projectId: "p",
      status: feedback.decision === "approve" ? "approved" : "denied",
      mode: "plan",
      createdAt: "",
      updatedAt: "",
      feedback,
    }),
    endSession: async () => undefined,
  };
}

function makeHost(provider: PlanProvider | null = makeProvider()) {
  return {
    storage: makeMemoryStorage(),
    serviceRegistry: {
      getProvider<T>(type: string): T | undefined {
        if (type !== "plan" || !provider) return undefined;
        return provider as T;
      },
      getProviderByName<T>(type: string, name: string): T | undefined {
        if (type !== "plan" || !provider) return undefined;
        if (provider.name !== name) return undefined;
        return provider as T;
      },
      listProvidersForType(type: string) {
        if (type !== "plan" || !provider) return [];
        return [{ pluginName: provider.name, isDefault: true }];
      },
    },
    telemetry: { emit() {} },
  };
}

async function jsonRequest(
  app: Elysia,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.handle(req);
  const text = await res.text();
  const parsed = text.length ? JSON.parse(text) : null;
  return { status: res.status, body: parsed };
}

describe("plan routes", () => {
  let app: ReturnType<typeof createPlanRoutes>;

  beforeEach(() => {
    app = createPlanRoutes(makeHost());
  });

  afterEach(() => {
    // Elysia stops cleanly on garbage collection; nothing to do.
  });

  it("GET /api/plan/health reports providers + active sessions", async () => {
    const { status, body } = await jsonRequest(app, "GET", "/api/plan/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, providers: 1, activeSessions: 0 });
  });

  it("GET /api/plan/providers returns the registered provider", async () => {
    const { status, body } = await jsonRequest(
      app,
      "GET",
      "/api/plan/providers",
    );
    expect(status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({
        name: "stub",
        isDefault: true,
        capabilities: expect.objectContaining({ modes: ["plan", "review"] }),
      }),
    ]);
  });

  it("POST /api/plan/sessions starts a session via the provider", async () => {
    const { status, body } = await jsonRequest(
      app,
      "POST",
      "/api/plan/sessions",
      { projectId: "p1", mode: "plan" },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      providerName: "stub",
      projectId: "p1",
      status: "active",
    });
  });

  it("POST /api/plan/sessions accepts Claude's ExitPlanMode hook shape", async () => {
    // The hook forwards its raw PreToolUse payload (no projectId; plan under
    // tool_input.plan). Previously this 422'd and the hook swallowed it.
    const { status, body } = await jsonRequest(
      app,
      "POST",
      "/api/plan/sessions",
      {
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "# Ship it\n- step one" },
        cwd: "/home/dev/my-project",
        session_id: "claude-abc123",
      },
    );
    expect(status).toBe(200);
    // projectId is synthesised from the cwd basename.
    expect(body).toMatchObject({
      providerName: "stub",
      projectId: "my-project",
      status: "active",
    });
  });

  it("POST /api/plan/sessions returns 503 when no provider is registered", async () => {
    const bareApp = createPlanRoutes(makeHost(null));
    const { status, body } = await jsonRequest(
      bareApp,
      "POST",
      "/api/plan/sessions",
      { projectId: "p1" },
    );
    expect(status).toBe(503);
    expect((body as { code: string }).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("POST /api/plan/sessions/:id/feedback approves a session", async () => {
    const create = await jsonRequest(app, "POST", "/api/plan/sessions", {
      projectId: "p1",
    });
    const session = create.body as PlanSession;

    const { status, body } = await jsonRequest(
      app,
      "POST",
      `/api/plan/sessions/${session.id}/feedback`,
      { decision: "approve", comment: "lgtm" },
    );
    expect(status).toBe(200);
    expect((body as PlanSession).status).toBe("approved");
  });

  it("GET /api/plan/sessions/:id returns 404 for unknown id", async () => {
    const { status, body } = await jsonRequest(
      app,
      "GET",
      "/api/plan/sessions/unknown",
    );
    expect(status).toBe(404);
    expect((body as { code: string }).code).toBe("SESSION_NOT_FOUND");
  });
});

describe("normalizeStartRequest", () => {
  it("passes the canonical UI/CLI shape through unchanged", () => {
    const { provider, startReq } = normalizeStartRequest({
      provider: "plannotator",
      projectId: "p1",
      prompt: "# Plan",
      mode: "plan",
      agent: "cli",
      timeoutMs: 1000,
    });
    expect(provider).toBe("plannotator");
    expect(startReq).toEqual({
      projectId: "p1",
      prompt: "# Plan",
      mode: "plan",
      agent: "cli",
      timeoutMs: 1000,
    });
  });

  it("maps Claude's ExitPlanMode hook: tool_input.plan→prompt, cwd→projectId, agent=claude-code", () => {
    const { startReq } = normalizeStartRequest({
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Ship it" },
      cwd: "/home/dev/my-project",
      session_id: "claude-abc",
    });
    expect(startReq.prompt).toBe("# Ship it");
    expect(startReq.projectId).toBe("my-project");
    expect(startReq.agent).toBe("claude-code");
    expect(startReq.mode).toBeUndefined(); // → provider defaults to plan
  });

  it("falls back projectId: cwd basename → session_id → 'default'", () => {
    expect(normalizeStartRequest({ session_id: "s1" }).startReq.projectId).toBe(
      "s1",
    );
    expect(normalizeStartRequest({}).startReq.projectId).toBe("default");
    // A root cwd has an empty basename → use the cwd itself.
    expect(normalizeStartRequest({ cwd: "/" }).startReq.projectId).toBe("/");
  });

  it("prefers an explicit prompt over tool_input.plan", () => {
    const { startReq } = normalizeStartRequest({
      prompt: "explicit",
      tool_input: { plan: "from-hook" },
    });
    expect(startReq.prompt).toBe("explicit");
  });
});
