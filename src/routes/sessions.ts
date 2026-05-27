import { basename } from "node:path";

import { Elysia, t } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { PlanDispatcher } from "../lib/dispatcher.js";
import { SessionStore } from "../lib/session-store.js";
import { mintSessionId } from "../lib/uuid.js";
import type {
  PlanErrorBody,
  PlanMode,
  PlanSession,
  StartSessionRequest,
} from "../types.js";

function errorBody(error: string, code: PlanErrorBody["code"]): PlanErrorBody {
  return { error, code };
}

/**
 * Body accepted by `POST /sessions`. Two shapes land here:
 *  - the UI / CLI canonical `{ projectId, prompt, mode, ... }`.
 *  - an AI coding agent's plan hook, forwarding its raw payload. Claude
 *    Code's ExitPlanMode PreToolUse hook posts
 *    `{ tool_name, tool_input: { plan }, cwd, session_id }` — no projectId,
 *    plan text under `tool_input.plan`.
 */
interface SessionPostBody {
  provider?: string;
  projectId?: string;
  prompt?: string;
  mode?: PlanMode;
  agent?: string;
  timeoutMs?: number;
  tool_input?: { plan?: string };
  tool_name?: string;
  cwd?: string;
  session_id?: string;
}

/**
 * Map either request shape onto a canonical StartSessionRequest. The agent
 * hook fires `curl … || true`, so a 422 here would fail *silently* and no
 * plan would ever reach the UI — hence we normalise rather than reject:
 * pull the plan from `tool_input.plan`, and synthesise a projectId from the
 * cwd basename / session id when the hook doesn't supply one.
 */
export function normalizeStartRequest(body: SessionPostBody): {
  provider?: string;
  startReq: StartSessionRequest;
} {
  const prompt = body.prompt ?? body.tool_input?.plan;
  const projectId =
    body.projectId ??
    (body.cwd ? basename(body.cwd) || body.cwd : undefined) ??
    body.session_id ??
    "default";
  const agent =
    body.agent ??
    (body.tool_name === "ExitPlanMode" ? "claude-code" : undefined);
  return {
    provider: body.provider,
    startReq: {
      projectId,
      prompt,
      mode: body.mode,
      agent,
      timeoutMs: body.timeoutMs,
    },
  };
}

function toLogPayload(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

export function createSessionRoutes(host: HostServices) {
  const dispatcher = new PlanDispatcher(host);
  const store = new SessionStore(host);

  return new Elysia()
    .get("/sessions", async ({ query }) => {
      const limit = query.limit ? Number(query.limit) : undefined;
      const sessions = await store.list({
        status: query.status as PlanSession["status"] | undefined,
        projectId: query.projectId,
        provider: query.provider,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return sessions;
    })
    .get("/sessions/:id", async ({ params, set }) => {
      const session = await store.get(params.id);
      if (!session) {
        set.status = 404;
        return errorBody(
          `Plan session '${params.id}' not found`,
          "SESSION_NOT_FOUND",
        );
      }
      // Refresh from provider if still active — providers are the source
      // of truth for live content + status.
      if (session.status === "active") {
        const provider = dispatcher.resolve(session.providerName);
        if (provider) {
          try {
            const fresh = await provider.getSession(session.id);
            if (fresh) {
              await store.save(fresh);
              return fresh;
            }
          } catch (err) {
            host.logger?.warn?.(
              "plan",
              `provider refresh failed for ${session.id}`,
              toLogPayload(err),
            );
          }
        }
      }
      return session;
    })
    .post(
      "/sessions",
      async ({ body, set }) => {
        const { provider: providerName, startReq } =
          normalizeStartRequest(body);
        const provider = dispatcher.resolve(providerName);
        if (!provider) {
          set.status = 503;
          return errorBody(
            providerName
              ? `Plan provider '${providerName}' not registered`
              : "No plan provider registered",
            providerName ? "PROVIDER_NOT_FOUND" : "PROVIDER_UNAVAILABLE",
          );
        }
        try {
          const fromProvider = await provider.startSession(startReq);
          const session: PlanSession = {
            ...fromProvider,
            // Override the provider's session id with our canonical UUID.
            // Providers may also key on their own slug — they should stash
            // it in `providerData` before returning.
            id: fromProvider.id || mintSessionId(),
            providerName: provider.name,
            createdAt: fromProvider.createdAt ?? new Date().toISOString(),
            updatedAt: fromProvider.updatedAt ?? new Date().toISOString(),
          };
          await store.save(session);
          host.telemetry?.emit("plan.session.started", {
            sessionId: session.id,
            provider: provider.name,
            projectId: session.projectId,
            mode: session.mode,
          });
          return session;
        } catch (err) {
          set.status = 500;
          return errorBody(
            err instanceof Error
              ? err.message
              : "Provider failed to start session",
            "PROVIDER_ERROR",
          );
        }
      },
      {
        // projectId is Optional (not required): the agent hook shape has no
        // projectId — it's synthesised in normalizeStartRequest. `additional
        // Properties` stays open so a hook can forward its full payload
        // (hook_event_name, transcript_path, …) without tripping validation.
        body: t.Object(
          {
            provider: t.Optional(t.String()),
            projectId: t.Optional(t.String({ minLength: 1 })),
            prompt: t.Optional(t.String()),
            mode: t.Optional(
              t.Union([
                t.Literal("plan"),
                t.Literal("review"),
                t.Literal("annotate"),
                t.Literal("archive"),
              ]),
            ),
            agent: t.Optional(t.String()),
            timeoutMs: t.Optional(t.Number()),
            // Claude Code ExitPlanMode PreToolUse hook payload.
            tool_input: t.Optional(t.Object({ plan: t.Optional(t.String()) })),
            tool_name: t.Optional(t.String()),
            cwd: t.Optional(t.String()),
            session_id: t.Optional(t.String()),
          },
          { additionalProperties: true },
        ),
      },
    )
    .delete("/sessions/:id", async ({ params, set }) => {
      const session = await store.get(params.id);
      if (!session) {
        set.status = 404;
        return errorBody(
          `Plan session '${params.id}' not found`,
          "SESSION_NOT_FOUND",
        );
      }
      const provider = dispatcher.resolve(session.providerName);
      if (provider) {
        try {
          await provider.endSession(params.id);
        } catch (err) {
          host.logger?.warn?.(
            "plan",
            `provider endSession failed for ${params.id}`,
            toLogPayload(err),
          );
        }
      }
      await store.patchStatus(params.id, "ended");
      host.telemetry?.emit("plan.session.ended", {
        sessionId: params.id,
        provider: session.providerName,
        reason: "user",
      });
      set.status = 204;
      return null;
    });
}
