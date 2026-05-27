/**
 * SessionStore — persists PlanSession metadata in the agent's storage
 * façade under the `plans` namespace. Provider state (pids, ports, slugs)
 * goes in `providerData` and stays opaque to the store.
 */

import type { HostServices } from "@vibecontrols/plugin-sdk";

import type {
  ListSessionsFilter,
  PlanSession,
  PlanSessionStatus,
} from "../types.js";

const NAMESPACE = "plans";

function matches(session: PlanSession, filter?: ListSessionsFilter): boolean {
  if (!filter) return true;
  if (filter.status && session.status !== filter.status) return false;
  if (filter.projectId && session.projectId !== filter.projectId) return false;
  if (filter.provider && session.providerName !== filter.provider) return false;
  return true;
}

export class SessionStore {
  constructor(private readonly host: HostServices) {}

  async save(session: PlanSession): Promise<void> {
    if (!this.host.storage) return;
    // Serialise to JSON. The SDK's StorageProvider is typed `value: T`, but
    // the skalex adapter (the agent's default storage) requires string values
    // and rejects raw objects ("Field 'value' must be of type 'string', got
    // 'object'"). Stringifying matches the convention used across plugins
    // (e.g. vibe-plugin-ai) and keeps persistence adapter-agnostic.
    await this.host.storage.set(NAMESPACE, session.id, JSON.stringify(session));
  }

  async get(id: string): Promise<PlanSession | null> {
    if (!this.host.storage) return null;
    const raw = await this.host.storage.get<string | PlanSession>(
      NAMESPACE,
      id,
    );
    if (raw == null) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as PlanSession;
      } catch {
        return null;
      }
    }
    // Defensive: an adapter that already deserialises returns the object as-is.
    return raw;
  }

  async list(filter?: ListSessionsFilter): Promise<PlanSession[]> {
    if (!this.host.storage || !this.host.storage.list) return [];
    const ids = await this.host.storage.list(NAMESPACE);
    const sessions = await Promise.all(ids.map((id) => this.get(id)));
    const filtered = sessions.filter(
      (entry): entry is PlanSession => entry !== null && matches(entry, filter),
    );
    if (filter?.limit && filtered.length > filter.limit) {
      return filtered.slice(0, filter.limit);
    }
    return filtered;
  }

  async delete(id: string): Promise<void> {
    if (!this.host.storage) return;
    await this.host.storage.delete(NAMESPACE, id);
  }

  async patchStatus(
    id: string,
    status: PlanSessionStatus,
    extra?: Partial<PlanSession>,
  ): Promise<PlanSession | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const next: PlanSession = {
      ...existing,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
      endedAt:
        status === "approved" ||
        status === "denied" ||
        status === "abandoned" ||
        status === "ended"
          ? new Date().toISOString()
          : existing.endedAt,
    };
    await this.save(next);
    return next;
  }
}
