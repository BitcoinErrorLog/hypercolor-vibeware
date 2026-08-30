import {
  scopeTouchesForbidden,
  scopeWithinWritable,
} from "./scope.js";
import type { SurfaceRecord } from "./surfaces.js";

export const PROBLEM_STATES = ["detected", "rejected", "pending_qualify", "qualified"] as const;
export type ProblemState = (typeof PROBLEM_STATES)[number];

export type QualificationGates = {
  repeated: boolean;
  /** Event-count volume (`sampleSize >= 3`), not distinct users. */
  min_volume: boolean;
  known_incident: boolean;
  measurement_changed: boolean;
  within_surface_scope: boolean;
  touches_forbidden_boundary: boolean;
  enough_evidence: boolean;
  roadmap_relevant: boolean;
};

export type Qualification = {
  gates: QualificationGates;
  /** Advisory only. `decideState` ignores this and uses the forbidden-boundary gate. */
  qualification_score: number;
  decision: "rejected" | "pending_qualify" | "qualified";
  reject_reason?: "validation_failed";
  detector_key: string;
  evidence_window: { start: string; end: string };
  evidence_types: string[];
  sample_size: number;
  bucket_count: number;
  metrics: Record<string, number>;
  human?: { actor: string; reason: string; at: string; qualified: boolean };
};

export function qualificationScore(gates: QualificationGates): number {
  let n = 0;
  if (gates.repeated) n += 1;
  if (gates.min_volume) n += 1;
  if (gates.within_surface_scope) n += 1;
  if (!gates.touches_forbidden_boundary) n += 1;
  if (gates.enough_evidence) n += 1;
  if (gates.roadmap_relevant) n += 1;
  return n / 6;
}

export function evaluateGates(input: {
  suspectedScope: readonly string[];
  surface: SurfaceRecord;
  sampleSize: number;
  bucketCount: number;
  minSample: number;
  minBuckets: number;
  roadmapRelevant: boolean;
}): QualificationGates {
  const touches = scopeTouchesForbidden(input.suspectedScope, input.surface.forbidden_paths);
  const withinWritable = scopeWithinWritable(input.suspectedScope, input.surface.writable_paths);
  return {
    repeated: input.bucketCount >= 2 || input.sampleSize >= 2,
    min_volume: input.sampleSize >= 3,
    known_incident: false,
    measurement_changed: false,
    within_surface_scope: withinWritable && !touches,
    touches_forbidden_boundary: touches,
    enough_evidence: input.sampleSize >= input.minSample && input.bucketCount >= input.minBuckets,
    roadmap_relevant: input.roadmapRelevant,
  };
}

export function decideState(gates: QualificationGates): {
  state: Extract<ProblemState, "rejected" | "pending_qualify">;
  reject_reason?: "validation_failed";
} {
  if (gates.touches_forbidden_boundary) {
    return { state: "rejected", reject_reason: "validation_failed" };
  }
  return { state: "pending_qualify" };
}

export function buildQualification(input: {
  gates: QualificationGates;
  detectorKey: string;
  evidenceWindow: { start: string; end: string };
  evidenceTypes: string[];
  sampleSize: number;
  bucketCount: number;
  metrics: Record<string, number>;
}): Qualification {
  const decision = decideState(input.gates);
  return {
    gates: input.gates,
    qualification_score: qualificationScore(input.gates),
    decision: decision.state,
    reject_reason: decision.reject_reason,
    detector_key: input.detectorKey,
    evidence_window: input.evidenceWindow,
    evidence_types: input.evidenceTypes,
    sample_size: input.sampleSize,
    bucket_count: input.bucketCount,
    metrics: input.metrics,
  };
}

export function isForbiddenRejection(qualification: Qualification | null | undefined, state: string): boolean {
  if (state !== "rejected") return false;
  if (!qualification) return false;
  return (
    qualification.reject_reason === "validation_failed" ||
    qualification.gates.touches_forbidden_boundary === true
  );
}
