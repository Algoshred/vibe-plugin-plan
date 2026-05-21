/**
 * @vibecontrols/vibe-plugin-plan — public types
 *
 * The PlanProvider contract that provider plugins implement, plus the
 * session/feedback/annotation shapes the meta plugin persists and exposes
 * over `/api/plan/*`.
 *
 * Providers register themselves with the agent's ServiceRegistry under the
 * `"plan"` provider type. The meta plugin's routes resolve a provider by
 * name (body `provider`) or fall back to the registry's default.
 */

export type PlanMode = "plan" | "review" | "annotate" | "archive";

export type PlanSessionStatus =
  | "pending"
  | "active"
  | "approved"
  | "denied"
  | "abandoned"
  | "ended";

export interface PlanProviderCapabilities {
  /** Modes this provider can produce sessions for. */
  modes: PlanMode[];
  /** True if `streamSession()` is implemented as a true stream. */
  supportsStreaming: boolean;
  /** True if `getSession(id).content.version` is meaningful. */
  supportsVersionHistory: boolean;
  /** True if annotations can be attached to feedback. */
  supportsAnnotations: boolean;
  /** True if archived plans can be listed via `listSessions({ status: 'ended' })`. */
  supportsArchive: boolean;
  /** True if the provider hosts the plan UI itself (e.g. cloud-hosted). */
  externallyHosted: boolean;
  /**
   * Optional REST prefix the provider exposes for prerequisite checks
   * (e.g. `/api/plan-plannotator`). The microfe's wizard polls this
   * prefix to gate UI states.
   */
  prereqApiPrefix?: string;
}

export interface PlanContent {
  /** Raw markdown rendered by the UI. */
  markdown: string;
  /** Monotonic version number, if the provider supports history. */
  version?: number;
  /** The agent or tool that produced this plan (e.g. `claude-code`). */
  origin?: string;
  /** Previous markdown snapshot used as the diff base. */
  previousMarkdown?: string;
}

export interface PlanAnnotation {
  id: string;
  /** Anchor expression — selector, character range, or path. */
  selector: string;
  text: string;
  author?: string;
  createdAt: string;
}

export interface PlanFeedback {
  decision: "approve" | "deny";
  comment?: string;
  annotations?: PlanAnnotation[];
}

export interface PlanSession {
  /** Canonical session id — minted by the meta plugin (UUIDv7-ish). */
  id: string;
  /** Provider that owns the session (e.g. `plannotator`). */
  providerName: string;
  /** Project / vibe identifier — opaque to the meta plugin. */
  projectId: string;
  status: PlanSessionStatus;
  mode: PlanMode;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  /**
   * Agent-relative UI URL the frontend should iframe (e.g.
   * `/plan/<sessionId>/?sessionId=...`). The microfe prepends the
   * agent's tunnel base before rendering.
   */
  uiUrl?: string;
  /** Latest plan content snapshot, refreshed on `getSession()` poll. */
  content?: PlanContent;
  /** Aggregated feedback once the session has a terminal decision. */
  feedback?: PlanFeedback;
  /** Provider-private blob — pid, port, slug, etc. Never exposed in UI. */
  providerData?: Record<string, unknown>;
}

export interface StartSessionRequest {
  projectId: string;
  /** Initial plan markdown (plan mode) or diff context (review mode). */
  prompt?: string;
  mode?: PlanMode;
  /** Origin tag — `claude-code`, `opencode`, `codex`, etc. */
  agent?: string;
  /** Override the provider-specific idle timeout (ms). */
  timeoutMs?: number;
}

export interface ListSessionsFilter {
  status?: PlanSessionStatus;
  projectId?: string;
  provider?: string;
  limit?: number;
}

/**
 * The contract every plan provider implements.
 *
 * Providers may implement `streamSession()` to expose true SSE; if absent,
 * the meta plugin falls back to a 2 s poll loop over `getSession()`.
 */
export interface PlanProvider {
  readonly name: string;
  getCapabilities(): PlanProviderCapabilities;
  startSession(req: StartSessionRequest): Promise<PlanSession>;
  getSession(id: string): Promise<PlanSession | null>;
  listSessions(filter?: ListSessionsFilter): Promise<PlanSession[]>;
  submitFeedback(id: string, feedback: PlanFeedback): Promise<PlanSession>;
  endSession(id: string): Promise<void>;
  streamSession?(id: string): AsyncIterable<PlanContent>;
}

export type PlanErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "PROVIDER_ERROR"
  | "PREREQ_MISSING"
  | "BAD_REQUEST";

export interface PlanErrorBody {
  error: string;
  code: PlanErrorCode;
}
