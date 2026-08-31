import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { prepareProblems, runDetectors, type DetectorHit } from "./detectors.js";
import { isForbiddenRejection, type Qualification } from "./qualify.js";
import { readProjectionView, serializeProjection } from "./projection.js";
import { scopeTouchesForbidden, unionForbiddenPaths } from "./scope.js";
import { loadSurface, loadSurfaces, type SurfaceRecord } from "./surfaces.js";

export type ProblemRow = {
  id: string;
  surface_id: string;
  detector_key: string | null;
  title: string;
  summary: string;
  suspected_scope: unknown;
  qualification: unknown;
  state: string;
};

export type CandidateArtifact = {
  surface: string;
  evidence_refs: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  budgets: {
    max_files_changed: number;
    max_new_dependencies: number;
    max_initial_percent: number;
    requires_human_for_percent_over: number;
    minimum_exposure_hours: number;
  };
};

export type CandidateRow = {
  id: string;
  problem_id: string;
  state: string;
  artifact: CandidateArtifact;
};

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

export function problemScope(row: ProblemRow): string[] {
  return asJson<string[]>(row.suspected_scope ?? []);
}

export function problemQualification(row: ProblemRow): Qualification | null {
  if (row.qualification == null) return null;
  return asJson<Qualification>(row.qualification);
}

export async function recordTransition(
  db: Database,
  input: {
    objectType: string;
    objectId: string;
    fromState: string | null;
    toState: string;
    actor: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO state_transitions (object_type, object_id, from_state, to_state, actor, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.objectType,
      input.objectId,
      input.fromState,
      input.toState,
      input.actor,
      input.reason ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

async function findOpenProblem(
  db: Database,
  surfaceId: string,
  detectorKey: string,
): Promise<ProblemRow | undefined> {
  const rows = await db.query<ProblemRow>(
    `SELECT id, surface_id, detector_key, title, summary, suspected_scope, qualification, state
     FROM problems
     WHERE surface_id = $1 AND detector_key = $2
       AND state IN ('detected', 'pending_qualify', 'qualified')
     ORDER BY created_at DESC
     LIMIT 1`,
    [surfaceId, detectorKey],
  );
  return rows[0];
}

export async function persistPreparedProblem(db: Database, prepared: ReturnType<typeof prepareProblems>[number]) {
  const existing = await findOpenProblem(db, prepared.surfaceId, prepared.detectorKey);
  const nextState = prepared.qualification.decision;
  if (existing) {
    if (existing.state === "qualified") return existing;
    await db.query(
      `UPDATE problems
       SET title = $2, summary = $3, suspected_scope = $4::jsonb, qualification = $5::jsonb, state = $6
       WHERE id = $1`,
      [
        existing.id,
        prepared.title,
        prepared.summary,
        JSON.stringify(prepared.suspectedScope),
        JSON.stringify(prepared.qualification),
        nextState,
      ],
    );
    if (existing.state !== nextState) {
      await recordTransition(db, {
        objectType: "problem",
        objectId: existing.id,
        fromState: existing.state,
        toState: nextState,
        actor: "detector",
        reason: prepared.qualification.reject_reason ?? "gates_evaluated",
      });
    }
    const updated = await loadProblem(db, existing.id);
    return updated ?? existing;
  }

  const id = `prob_${randomUUID()}`;
  await db.query(
    `INSERT INTO problems (id, surface_id, detector_key, title, summary, suspected_scope, qualification, state)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      id,
      prepared.surfaceId,
      prepared.detectorKey,
      prepared.title,
      prepared.summary,
      JSON.stringify(prepared.suspectedScope),
      JSON.stringify(prepared.qualification),
      nextState,
    ],
  );
  await recordTransition(db, {
    objectType: "problem",
    objectId: id,
    fromState: null,
    toState: "detected",
    actor: "detector",
    reason: prepared.detectorKey,
  });
  await recordTransition(db, {
    objectType: "problem",
    objectId: id,
    fromState: "detected",
    toState: nextState,
    actor: "detector",
    reason: prepared.qualification.reject_reason ?? "gates_evaluated",
  });
  const created = await loadProblem(db, id);
  if (!created) throw new Error(`problem ${id} missing after insert`);
  return created;
}

export async function loadProblem(db: Database, id: string): Promise<ProblemRow | undefined> {
  const rows = await db.query<ProblemRow>(
    `SELECT id, surface_id, detector_key, title, summary, suspected_scope, qualification, state
     FROM problems WHERE id = $1`,
    [id],
  );
  return rows[0];
}

export async function listProblems(db: Database): Promise<ProblemRow[]> {
  return db.query<ProblemRow>(
    `SELECT id, surface_id, detector_key, title, summary, suspected_scope, qualification, state
     FROM problems
     ORDER BY created_at DESC, id`,
  );
}

export async function detectProblems(
  db: Database,
  now: Date,
  extraHits: readonly DetectorHit[] = [],
): Promise<ProblemRow[]> {
  const surfaces = await loadSurfaces(db);
  const rows = serializeProjection(await readProjectionView(db));
  const hits = runDetectors(rows, surfaces, now, extraHits);
  const prepared = prepareProblems(hits, surfaces);
  const problems: ProblemRow[] = [];
  for (const item of prepared) {
    problems.push(await persistPreparedProblem(db, item));
  }
  return problems;
}

export async function qualifyProblem(
  db: Database,
  input: { id: string; qualified: boolean; actor: string; reason: string; now: Date },
): Promise<{ ok: true; problem: ProblemRow } | { ok: false; reason: string; status: 403 | 404 }> {
  const problem = await loadProblem(db, input.id);
  if (!problem) return { ok: false, reason: "not_found", status: 404 };
  const qualification = problemQualification(problem);
  if (isForbiddenRejection(qualification, problem.state)) {
    return { ok: false, reason: "validation_failed", status: 403 };
  }
  if (problem.state === "rejected") {
    return { ok: false, reason: "unqualified", status: 403 };
  }
  if (problem.state === "qualified" && input.qualified) {
    return { ok: true, problem };
  }
  if (problem.state !== "detected" && problem.state !== "pending_qualify" && problem.state !== "qualified") {
    return { ok: false, reason: "unqualified", status: 403 };
  }
  const nextState = input.qualified ? "qualified" : "rejected";
  const nextQualification: Qualification = {
    ...(qualification ?? {
      gates: {
        repeated: false,
        min_volume: false,
        known_incident: false,
        measurement_changed: false,
        within_surface_scope: true,
        touches_forbidden_boundary: false,
        enough_evidence: false,
        roadmap_relevant: false,
      },
      qualification_score: 0,
      decision: nextState,
      detector_key: problem.detector_key ?? "",
      evidence_window: { start: input.now.toISOString(), end: input.now.toISOString() },
      evidence_types: [],
      sample_size: 0,
      bucket_count: 0,
      metrics: {},
    }),
    decision: nextState,
    human: {
      actor: input.actor,
      reason: input.reason,
      at: input.now.toISOString(),
      qualified: input.qualified,
    },
  };
  await db.query(`UPDATE problems SET qualification = $2::jsonb, state = $3 WHERE id = $1`, [
    problem.id,
    JSON.stringify(nextQualification),
    nextState,
  ]);
  await recordTransition(db, {
    objectType: "problem",
    objectId: problem.id,
    fromState: problem.state,
    toState: nextState,
    actor: input.actor,
    reason: input.reason,
    metadata: { qualified: input.qualified },
  });
  const updated = await loadProblem(db, problem.id);
  if (!updated) return { ok: false, reason: "not_found", status: 404 };
  return { ok: true, problem: updated };
}

async function evidenceIdsFor(
  db: Database,
  surfaceId: string,
  qualification: Qualification | null,
): Promise<string[]> {
  if (!qualification || qualification.evidence_types.length === 0) return [];
  const typeClauses = qualification.evidence_types.map((_, index) => `type = $${index + 4}`);
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM evidence
     WHERE model_allowed = true
       AND occurred_at >= $1::timestamptz
       AND occurred_at < $2::timestamptz
       AND surface_id = $3
       AND (${typeClauses.join(" OR ")})
     ORDER BY occurred_at, id`,
    [
      qualification.evidence_window.start,
      qualification.evidence_window.end,
      surfaceId,
      ...qualification.evidence_types,
    ],
  );
  return rows.map((row) => row.id);
}

function pathBudgets(surface: SurfaceRecord): CandidateArtifact["budgets"] {
  return {
    max_files_changed: Math.max(12, surface.writable_paths.length),
    max_new_dependencies: 0,
    max_initial_percent: surface.max_initial_percent,
    requires_human_for_percent_over: surface.requires_human_for_percent_over,
    minimum_exposure_hours: surface.minimum_exposure_hours,
  };
}

export async function generateCandidate(
  db: Database,
  problemId: string,
): Promise<
  | { ok: true; created: boolean; candidate: CandidateRow }
  | { ok: false; reason: string; status: 403 | 404 }
> {
  const problem = await loadProblem(db, problemId);
  if (!problem) return { ok: false, reason: "not_found", status: 404 };
  if (problem.state !== "qualified") {
    return { ok: false, reason: "unqualified", status: 403 };
  }
  const surface = await loadSurface(db, problem.surface_id);
  if (!surface) return { ok: false, reason: "not_found", status: 404 };
  const scope = problemScope(problem);
  if (scopeTouchesForbidden(scope, surface.forbidden_paths)) {
    return { ok: false, reason: "validation_failed", status: 403 };
  }
  const existing = await db.query<CandidateRow>(
    `SELECT id, problem_id, state, artifact
     FROM candidates
     WHERE problem_id = $1 AND state = 'request_ready'
     ORDER BY created_at DESC
     LIMIT 1`,
    [problemId],
  );
  if (existing[0]) {
    return {
      ok: true,
      created: false,
      candidate: {
        ...existing[0],
        artifact: asJson<CandidateArtifact>(existing[0].artifact),
      },
    };
  }
  const qualification = problemQualification(problem);
  const artifact: CandidateArtifact = {
    surface: surface.id,
    evidence_refs: await evidenceIdsFor(db, problem.surface_id, qualification),
    allowed_paths: [...surface.writable_paths],
    forbidden_paths: unionForbiddenPaths(surface.forbidden_paths),
    budgets: pathBudgets(surface),
  };
  const id = `cand_${randomUUID()}`;
  await db.query(
    `INSERT INTO candidates (id, problem_id, state, base_sha, artifact)
     VALUES ($1, $2, 'request_ready', 'unresolved', $3::jsonb)`,
    [id, problemId, JSON.stringify(artifact)],
  );
  await recordTransition(db, {
    objectType: "candidate",
    objectId: id,
    fromState: null,
    toState: "request_ready",
    actor: "generate",
    reason: "candidate_request",
    metadata: { problem_id: problemId },
  });
  return { ok: true, created: true, candidate: { id, problem_id: problemId, state: "request_ready", artifact } };
}

export function publicProblem(row: ProblemRow) {
  return {
    id: row.id,
    surface_id: row.surface_id,
    detector_key: row.detector_key,
    title: row.title,
    state: row.state,
    suspected_scope: problemScope(row),
    qualification: problemQualification(row),
  };
}
