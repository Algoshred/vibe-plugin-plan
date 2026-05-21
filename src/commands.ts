/**
 * Plugin CLI — `vibe plan ...` verbs.
 *
 * Talks to the agent's REST API at `${VIBE_AGENT_URL}/api/plan/*`.
 * Uses the SDK's `runMultimode` helper for JSON/plain/interactive output.
 */

import type { Command } from "commander";

import {
  runMultimode,
  pickOutputMode,
  maybePrintJson,
  redact,
  type OutputFlags,
} from "@vibecontrols/plugin-sdk";

import type { PlanSession } from "./types.js";

const AGENT_BASE_URL = process.env.VIBE_AGENT_URL ?? "http://localhost:3005";
const API_KEY = process.env.VIBE_AGENT_API_KEY ?? "";

async function apiFetch(
  urlPath: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${AGENT_BASE_URL}${urlPath}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": API_KEY,
      ...init?.headers,
    },
  });
}

export function registerPlanCommands(program: Command): void {
  const cmd = program.command("plan").description("Plan orchestration");

  cmd
    .command("providers")
    .description("List registered plan providers")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async (opts: OutputFlags) => {
      await runMultimode<
        Array<{ name: string; isDefault: boolean; capabilities: unknown }>
      >({
        mode: pickOutputMode(opts),
        fetchData: async () => {
          const res = await apiFetch("/api/plan/providers");
          return (await res.json()) as Array<{
            name: string;
            isDefault: boolean;
            capabilities: unknown;
          }>;
        },
        plain: (data) => {
          for (const entry of data) {
            const marker = entry.isDefault ? "*" : " ";
            process.stdout.write(`${marker} ${entry.name}\n`);
          }
        },
        interactive: async (data) => {
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        },
        json: (data) => redact(data),
      });
    });

  cmd
    .command("list")
    .description("List plan sessions")
    .option("--provider <name>", "Filter by provider")
    .option("--status <status>", "Filter by status")
    .option("--project <id>", "Filter by project id")
    .option("--limit <n>", "Limit results")
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(
      async (
        opts: {
          provider?: string;
          status?: string;
          project?: string;
          limit?: string;
        } & OutputFlags,
      ) => {
        const params = new URLSearchParams();
        if (opts.provider) params.set("provider", opts.provider);
        if (opts.status) params.set("status", opts.status);
        if (opts.project) params.set("projectId", opts.project);
        if (opts.limit) params.set("limit", opts.limit);
        const suffix = params.toString() ? `?${params.toString()}` : "";

        await runMultimode<PlanSession[]>({
          mode: pickOutputMode(opts),
          fetchData: async () => {
            const res = await apiFetch(`/api/plan/sessions${suffix}`);
            return (await res.json()) as PlanSession[];
          },
          plain: (data) => {
            for (const session of data) {
              process.stdout.write(
                `${session.id}\t${session.status}\t${session.providerName}\t${session.mode}\t${session.projectId}\n`,
              );
            }
          },
          interactive: async (data) => {
            process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
          },
          json: (data) => redact(data),
        });
      },
    );

  cmd
    .command("status <session-id>")
    .description("Show status for a plan session")
    .option("--json", "Emit JSON")
    .action(async (sessionId: string, opts: OutputFlags) => {
      const res = await apiFetch(`/api/plan/sessions/${sessionId}`);
      const data = await res.json();
      if (maybePrintJson(opts, data)) return;
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    });

  cmd
    .command("end <session-id>")
    .description("End a plan session")
    .option("--json", "Emit JSON")
    .action(async (sessionId: string, opts: OutputFlags) => {
      const res = await apiFetch(`/api/plan/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        if (maybePrintJson(opts, { ok: true })) return;
        process.stdout.write("ended\n");
        return;
      }
      const data = await res.json();
      if (maybePrintJson(opts, data)) return;
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    });
}
