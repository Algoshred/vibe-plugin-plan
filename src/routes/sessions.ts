import { Elysia, t } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { PlanDispatcher } from "../lib/dispatcher.js";
import { SessionStore } from "../lib/session-store.js";
import { mintSessionId } from "../lib/uuid.js";
import type {
  PlanErrorBody,
  PlanSession,
  StartSessionRequest,
} from "../types.js";

function errorBody(error: string, code: PlanErrorBody["code"]): PlanErrorBody {
  return { error, code };
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
        const req = body;
        const provider = dispatcher.resolve(req.provider);
        if (!provider) {
          set.status = 503;
          return errorBody(
            req.provider
              ? `Plan provider '${req.provider}' not registered`
              : "No plan provider registered",
            req.provider ? "PROVIDER_NOT_FOUND" : "PROVIDER_UNAVAILABLE",
          );
        }

        const startReq: StartSessionRequest = {
          projectId: req.projectId,
          prompt: req.prompt,
          mode: req.mode,
          agent: req.agent,
          timeoutMs: req.timeoutMs,
        };
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
        body: t.Object({
          provider: t.Optional(t.String()),
          projectId: t.String({ minLength: 1 }),
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
        }),
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
