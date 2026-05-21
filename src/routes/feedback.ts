import { Elysia, t } from "elysia";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import { PlanDispatcher } from "../lib/dispatcher.js";
import { SessionStore } from "../lib/session-store.js";
import type { PlanErrorBody, PlanFeedback } from "../types.js";

function errorBody(error: string, code: PlanErrorBody["code"]): PlanErrorBody {
  return { error, code };
}

export function createFeedbackRoutes(host: HostServices) {
  const dispatcher = new PlanDispatcher(host);
  const store = new SessionStore(host);

  return new Elysia().post(
    "/sessions/:id/feedback",
    async ({ params, body, set }) => {
      const existing = await store.get(params.id);
      if (!existing) {
        set.status = 404;
        return errorBody(
          `Plan session '${params.id}' not found`,
          "SESSION_NOT_FOUND",
        );
      }
      const provider = dispatcher.resolve(existing.providerName);
      if (!provider) {
        set.status = 503;
        return errorBody(
          `Provider '${existing.providerName}' not available`,
          "PROVIDER_UNAVAILABLE",
        );
      }
      try {
        const feedback: PlanFeedback = {
          decision: body.decision,
          comment: body.comment,
          annotations: body.annotations,
        };
        const updated = await provider.submitFeedback(params.id, feedback);
        await store.save(updated);
        host.telemetry?.emit("plan.session.feedback", {
          sessionId: params.id,
          provider: existing.providerName,
          decision: feedback.decision,
        });
        return updated;
      } catch (err) {
        set.status = 500;
        return errorBody(
          err instanceof Error ? err.message : "Provider failed feedback",
          "PROVIDER_ERROR",
        );
      }
    },
    {
      body: t.Object({
        decision: t.Union([t.Literal("approve"), t.Literal("deny")]),
        comment: t.Optional(t.String()),
        annotations: t.Optional(
          t.Array(
            t.Object({
              id: t.String(),
              selector: t.String(),
              text: t.String(),
              author: t.Optional(t.String()),
              createdAt: t.String(),
            }),
          ),
        ),
      }),
    },
  );
}
