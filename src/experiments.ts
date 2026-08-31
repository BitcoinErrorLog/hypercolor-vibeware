import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { isCredentialUrl, secretShapeReason } from "./privacy.js";
import { loadProblem, recordTransition } from "./problems.js";
import { readProjectionView, serializeProjection, type SerializedProjectionRow } from "./projection.js";
import { loadSurface, type SurfaceRecord } from "./surfaces.js";

export const MAX_INITIAL_PERCENT = 10;
export const V1_PERCENT_CAP = 25;
export const ASSIGNMENT_BUCKETS = 100;

export type PercentLimits = {
  max_initial_percent: number;
  requires_human_for_percent_over: number;
};

export const GLOBAL_PERCENT_LIMITS: PercentLimits = {
  max_initial_percent: MAX_INITIAL_PERCENT,
  requires_human_for_percent_over: V1_PERCENT_CAP,
};

const SHA256_HEX_RE = /^[0-9a-f]{40}$/;
const COHORT_KEY_RE = /^[0-9a-f]{64}$/i;
const BANNED_KEY_RE =
  /body|rawJson|recovery|token|pubky|secret|payment|attachment|cookie|authorization/i;
const HOUR_MS = 60 * 60 * 1000;

export type CandidateBuild = {
  sha: string;
  origin: string;
};

export type ExperimentConfig = {
  percent: number;
  candidate_build: CandidateBuild;
  human?: { actor: string; reason: string };
};

export type ExperimentRow = {
  id: string;
  candidate_id: string;
  config: unknown;
  state: string;
  killed: boolean;
  started_at: Date | string | null;
  ended_at: Date | string | null;
};

export type PublicExperiment = {
  id: string;
  candidate_id: string;
  state: string;
  killed: boolean;
  percent: number;
  candidate_build: CandidateBuild;
  started_at: string | null;
  ended_at: string | null;
};

export type Assignment = {
  bucket: "control" | "candidate";
  experiment_id: string;
  killed: boolean;
};

export type DecisionInput = {
  experiment_id: string;
  surface_id: string;
  killed: boolean;
  percent: number;
  window_days: 14;
  primary_metric: string;
  counts: {
    events_total: number;
    hour_buckets: number;
    app_error_coarse: number;
    send_settled_total: number;
    send_settled_failed: number;
    send_settled_sent: number;
    send_settled_queued: number;
    empty_state: number;
    chat_channel_views: number;
    onboarding_state: number;
    onboarding_abandoned: number;
    onboarding_live: number;
  };
  rates: {
    primary: number | null;
    app_error_coarse: number | null;
    send_settled_failed: number | null;
    send_settled_failed_baseline: number | null;
  };
  guardrails: {
    app_error_coarse_rate: number | null;
    send_settled_failed_increased: boolean | null;
  };
};

export type CreateExperimentInput = {
  candidateId: string;
  candidateSha: string;
  candidateOrigin: string;
  percent: number;
  actor?: string;
  reason?: string;
};

type Fail = { ok: false; reason: string; status: 400 | 403 | 404 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringHasBannedContent(value: string): boolean {
  if (BANNED_KEY_RE.test(value)) return true;
  if (secretShapeReason(value)) return true;
  return isCredentialUrl(value);
}

export function jsonHasBannedKey(value: unknown): boolean {
  if (typeof value === "string") return stringHasBannedContent(value);
  if (Array.isArray(value)) return value.some(jsonHasBannedKey);
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (BANNED_KEY_RE.test(key)) return true;
    if (jsonHasBannedKey(child)) return true;
  }
  return false;
}

export function enforcePercentLimits(
  percent: number,
  human: boolean,
  limits: PercentLimits = GLOBAL_PERCENT_LIMITS,
): { ok: true } | Fail {
  const hardCap = Math.min(limits.requires_human_for_percent_over, V1_PERCENT_CAP);
  const noHumanMax = Math.min(limits.max_initial_percent, MAX_INITIAL_PERCENT);
  if (percent > hardCap) return { ok: false, reason: "percent_over_cap", status: 403 };
  if (percent > noHumanMax && !human) {
    return { ok: false, reason: "percent_requires_human", status: 403 };
  }
  return { ok: true };
}

export function parseHttpsOrigin(value: string): string | null {
  if (value === "" || value === "*" || value === "null") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname === "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  return parsed.origin;
}

export function parseCandidateSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "latest" || trimmed.includes("latest") || trimmed.startsWith("origin/") || trimmed.startsWith("refs/")) {
    return null;
  }
  if (!SHA256_HEX_RE.test(trimmed)) return null;
  return trimmed;
}

export function assignmentUnit(experimentId: string, cohortKey: string): number {
  const digest = createHash("sha256")
    .update(experimentId, "utf8")
    .update("\0", "utf8")
    .update(cohortKey.toLowerCase(), "utf8")
    .digest();
  return digest.readUInt32BE(0) % ASSIGNMENT_BUCKETS;
}

export function assignmentBucket(experimentId: string, cohortKey: string, percent: number, killed: boolean): "control" | "candidate" {
  if (killed) return "control";
  return assignmentUnit(experimentId, cohortKey) < percent ? "candidate" : "control";
}

export function experimentConfig(row: ExperimentRow): ExperimentConfig {
  return asJson<ExperimentConfig>(row.config);
}

export function publicExperiment(row: ExperimentRow): PublicExperiment {
  const config = experimentConfig(row);
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    state: row.state,
    killed: row.killed,
    percent: config.percent,
    candidate_build: config.candidate_build,
    started_at: iso(row.started_at),
    ended_at: iso(row.ended_at),
  };
}

export function parseCreateExperimentBody(
  value: unknown,
  limits: PercentLimits = GLOBAL_PERCENT_LIMITS,
): { ok: true; input: CreateExperimentInput } | Fail {
  if (!isPlainObject(value)) return { ok: false, reason: "invalid_body", status: 400 };
  const candidateId = nonEmptyString(value.candidate_id);
  if (!candidateId || candidateId.length > 128) {
    return { ok: false, reason: "invalid_body", status: 400 };
  }
  const sha = parseCandidateSha(value.candidate_sha);
  if (!sha) return { ok: false, reason: "invalid_sha", status: 400 };
  if (typeof value.candidate_origin !== "string") {
    return { ok: false, reason: "invalid_origin", status: 400 };
  }
  const origin = parseHttpsOrigin(value.candidate_origin);
  if (!origin) return { ok: false, reason: "invalid_origin", status: 400 };

  let percent = MAX_INITIAL_PERCENT;
  if (Object.hasOwn(value, "percent")) {
    if (typeof value.percent !== "number" || !Number.isInteger(value.percent) || value.percent < 1 || value.percent > 100) {
      return { ok: false, reason: "invalid_body", status: 400 };
    }
    percent = value.percent;
  }

  const actor = nonEmptyString(value.actor);
  const reason = nonEmptyString(value.reason);
  const human = actor && reason ? { actor, reason } : undefined;
  const gated = enforcePercentLimits(percent, Boolean(human), limits);
  if (!gated.ok) return gated;

  return {
    ok: true,
    input: {
      candidateId,
      candidateSha: sha,
      candidateOrigin: origin,
      percent,
      actor: human?.actor,
      reason: human?.reason,
    },
  };
}

export function parseCohortKey(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!COHORT_KEY_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export async function loadExperiment(db: Database, id: string): Promise<ExperimentRow | undefined> {
  const rows = await db.query<ExperimentRow>(
    `SELECT id, candidate_id, config, state, killed, started_at, ended_at
     FROM experiments WHERE id = $1`,
    [id],
  );
  return rows[0];
}

export async function createExperiment(
  db: Database,
  input: CreateExperimentInput,
  now: Date,
): Promise<{ ok: true; created: true; experiment: ExperimentRow } | Fail> {
  const candidates = await db.query<{ id: string; problem_id: string; state: string }>(
    `SELECT id, problem_id, state FROM candidates WHERE id = $1`,
    [input.candidateId],
  );
  const candidate = candidates[0];
  if (!candidate || candidate.state !== "request_ready") {
    return { ok: false, reason: "candidate_not_ready", status: 403 };
  }

  const problem = await loadProblem(db, candidate.problem_id);
  if (!problem) return { ok: false, reason: "not_found", status: 404 };
  const surface = await loadSurface(db, problem.surface_id);
  if (!surface) return { ok: false, reason: "not_found", status: 404 };

  const human = Boolean(input.actor && input.reason);
  const gated = enforcePercentLimits(input.percent, human, {
    max_initial_percent: surface.max_initial_percent,
    requires_human_for_percent_over: surface.requires_human_for_percent_over,
  });
  if (!gated.ok) return gated;

  const noHumanMax = Math.min(surface.max_initial_percent, MAX_INITIAL_PERCENT);
  const config: ExperimentConfig = {
    percent: input.percent,
    candidate_build: { sha: input.candidateSha, origin: input.candidateOrigin },
  };
  if (input.percent > noHumanMax && input.actor && input.reason) {
    config.human = { actor: input.actor, reason: input.reason };
  }

  const id = `exp_${randomUUID()}`;
  const started = now.toISOString();
  await db.query(
    `INSERT INTO experiments (id, candidate_id, config, state, killed, started_at)
     VALUES ($1, $2, $3::jsonb, 'running', false, $4::timestamptz)`,
    [id, input.candidateId, JSON.stringify(config), started],
  );
  await recordTransition(db, {
    objectType: "experiment",
    objectId: id,
    fromState: null,
    toState: "running",
    actor: input.actor ?? "internal",
    reason: "created",
    metadata: { percent: input.percent },
  });
  const created = await loadExperiment(db, id);
  if (!created) return { ok: false, reason: "not_found", status: 404 };
  return { ok: true, created: true, experiment: created };
}

export async function assignExperiment(
  db: Database,
  id: string,
  cohortKey: string,
): Promise<{ ok: true; assignment: Assignment } | Fail> {
  const experiment = await loadExperiment(db, id);
  if (!experiment) return { ok: false, reason: "not_found", status: 404 };
  const config = experimentConfig(experiment);
  const killed = experiment.killed || experiment.state === "killed";
  return {
    ok: true,
    assignment: {
      bucket: assignmentBucket(experiment.id, cohortKey, config.percent, killed),
      experiment_id: experiment.id,
      killed,
    },
  };
}

export async function killExperiment(
  db: Database,
  id: string,
  now: Date,
): Promise<{ ok: true; experiment: ExperimentRow } | Fail> {
  const experiment = await loadExperiment(db, id);
  if (!experiment) return { ok: false, reason: "not_found", status: 404 };
  if (experiment.killed || experiment.state === "killed") {
    return { ok: true, experiment };
  }
  await db.query(
    `UPDATE experiments SET killed = true, state = 'killed', ended_at = $2::timestamptz WHERE id = $1`,
    [id, now.toISOString()],
  );
  await recordTransition(db, {
    objectType: "experiment",
    objectId: id,
    fromState: experiment.state,
    toState: "killed",
    actor: "kill_switch",
    reason: "kill",
  });
  const updated = await loadExperiment(db, id);
  if (!updated) return { ok: false, reason: "not_found", status: 404 };
  return { ok: true, experiment: updated };
}

function sendOutcome(row: SerializedProjectionRow): string | null {
  if (row.event_type !== "app.thread.send_settled" || !row.payload_class) return null;
  const parts = row.payload_class.split("|");
  return parts[1] ?? null;
}

function isChatChannelView(row: SerializedProjectionRow): boolean {
  if (row.event_type !== "app.route.viewed" || !row.payload_class) return false;
  return row.payload_class.startsWith("chat|") || row.payload_class.startsWith("channel|");
}

function sendFailedSplit(
  rows: readonly SerializedProjectionRow[],
  now: Date,
): { recent: number | null; baseline: number | null; increased: boolean | null } {
  const recentCutoff = now.getTime() - 24 * HOUR_MS;
  let recentFailed = 0;
  let recentTotal = 0;
  let baselineFailed = 0;
  let baselineTotal = 0;
  for (const row of rows) {
    const outcome = sendOutcome(row);
    if (!outcome) continue;
    const hour = new Date(row.hour).getTime();
    if (hour >= recentCutoff) {
      recentTotal += row.event_count;
      if (outcome === "failed") recentFailed += row.event_count;
    } else {
      baselineTotal += row.event_count;
      if (outcome === "failed") baselineFailed += row.event_count;
    }
  }
  const recent = recentTotal === 0 ? null : recentFailed / recentTotal;
  const baseline = baselineTotal === 0 ? null : baselineFailed / baselineTotal;
  const increased = recent == null || baseline == null ? null : recent > baseline;
  return { recent, baseline, increased };
}

function primaryRate(metric: string, counts: DecisionInput["counts"]): number | null {
  switch (metric) {
    case "empty_state_escape_rate":
      return counts.empty_state === 0 ? null : counts.chat_channel_views / counts.empty_state;
    case "send_settle_success":
      return counts.send_settled_total === 0 ? null : counts.send_settled_sent / counts.send_settled_total;
    case "onboarding_completion_rate":
      return counts.onboarding_state === 0 ? null : counts.onboarding_live / counts.onboarding_state;
    default:
      return null;
  }
}

export function buildDecisionInput(input: {
  experimentId: string;
  surface: SurfaceRecord;
  killed: boolean;
  percent: number;
  rows: readonly SerializedProjectionRow[];
  now: Date;
}): DecisionInput {
  const counts = {
    events_total: 0,
    hour_buckets: 0,
    app_error_coarse: 0,
    send_settled_total: 0,
    send_settled_failed: 0,
    send_settled_sent: 0,
    send_settled_queued: 0,
    empty_state: 0,
    chat_channel_views: 0,
    onboarding_state: 0,
    onboarding_abandoned: 0,
    onboarding_live: 0,
  };
  const hours = new Set<string>();
  for (const row of input.rows) {
    counts.events_total += row.event_count;
    hours.add(String(row.hour));
    if (row.event_type === "app.error.coarse") counts.app_error_coarse += row.event_count;
    if (row.event_type === "app.chat.empty_state") counts.empty_state += row.event_count;
    if (row.event_type === "app.onboarding.abandoned") counts.onboarding_abandoned += row.event_count;
    if (row.event_type === "app.onboarding.state") {
      counts.onboarding_state += row.event_count;
      if (row.payload_class === "live") counts.onboarding_live += row.event_count;
    }
    if (isChatChannelView(row)) counts.chat_channel_views += row.event_count;
    const outcome = sendOutcome(row);
    if (outcome) {
      counts.send_settled_total += row.event_count;
      if (outcome === "failed") counts.send_settled_failed += row.event_count;
      if (outcome === "sent") counts.send_settled_sent += row.event_count;
      if (outcome === "queued") counts.send_settled_queued += row.event_count;
    }
  }
  counts.hour_buckets = hours.size;
  const failed = sendFailedSplit(input.rows, input.now);
  const errorRate = counts.events_total === 0 ? null : counts.app_error_coarse / counts.events_total;
  const failedRate = counts.send_settled_total === 0 ? null : counts.send_settled_failed / counts.send_settled_total;
  const decision: DecisionInput = {
    experiment_id: input.experimentId,
    surface_id: input.surface.id,
    killed: input.killed,
    percent: input.percent,
    window_days: 14,
    primary_metric: input.surface.primary_metric,
    counts,
    rates: {
      primary: primaryRate(input.surface.primary_metric, counts),
      app_error_coarse: errorRate,
      send_settled_failed: failedRate,
      send_settled_failed_baseline: failed.baseline,
    },
    guardrails: {
      app_error_coarse_rate: errorRate,
      send_settled_failed_increased: failed.increased,
    },
  };
  if (jsonHasBannedKey(decision)) {
    throw new Error("decision_input contained a banned key");
  }
  return decision;
}

export async function evaluateExperiment(
  db: Database,
  id: string,
  now: Date,
): Promise<{ ok: true; evaluationId: string; decision_input: DecisionInput } | Fail> {
  const experiment = await loadExperiment(db, id);
  if (!experiment) return { ok: false, reason: "not_found", status: 404 };
  const candidates = await db.query<{ problem_id: string }>(
    `SELECT problem_id FROM candidates WHERE id = $1`,
    [experiment.candidate_id],
  );
  const problemId = candidates[0]?.problem_id;
  if (!problemId) return { ok: false, reason: "not_found", status: 404 };
  const problem = await loadProblem(db, problemId);
  if (!problem) return { ok: false, reason: "not_found", status: 404 };
  const surface = await loadSurface(db, problem.surface_id);
  if (!surface) return { ok: false, reason: "not_found", status: 404 };

  const startedMs =
    experiment.started_at == null
      ? null
      : experiment.started_at instanceof Date
        ? experiment.started_at.getTime()
        : new Date(experiment.started_at).getTime();
  if (startedMs == null || Number.isNaN(startedMs)) {
    return { ok: false, reason: "minimum_exposure_hours", status: 403 };
  }
  const requiredMs = surface.minimum_exposure_hours * HOUR_MS;
  if (now.getTime() - startedMs < requiredMs) {
    return { ok: false, reason: "minimum_exposure_hours", status: 403 };
  }

  const rows = serializeProjection(await readProjectionView(db));
  const config = experimentConfig(experiment);
  const killed = experiment.killed || experiment.state === "killed";
  const decision_input = buildDecisionInput({
    experimentId: experiment.id,
    surface,
    killed,
    percent: config.percent,
    rows,
    now,
  });

  const evaluationId = `eval_${randomUUID()}`;
  await db.query(`INSERT INTO evaluations (id, experiment_id, result) VALUES ($1, $2, $3::jsonb)`, [
    evaluationId,
    experiment.id,
    JSON.stringify({ decision_input }),
  ]);
  return { ok: true, evaluationId, decision_input };
}
