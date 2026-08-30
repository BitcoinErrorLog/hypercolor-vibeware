import { describe, expect, it } from "vitest";
import { evaluateGates, qualificationScore, type QualificationGates } from "../src/qualify.js";
import { parseSurface } from "../src/surfaces.js";

const surface = parseSurface({
  id: "hc-thread-ui",
  owner: "hypercolor",
  manifest: {
    scope: { writable_paths: ["src/components/composer.tsx"], forbidden_paths: [] },
    exposure: { max_initial_percent: 10, requires_human_for_percent_over: 25 },
    selection: { minimum_exposure_hours: 48 },
  },
});

function gates(overrides: Partial<QualificationGates> = {}): QualificationGates {
  return {
    repeated: true,
    min_volume: true,
    known_incident: false,
    measurement_changed: false,
    within_surface_scope: true,
    touches_forbidden_boundary: false,
    enough_evidence: true,
    roadmap_relevant: true,
    ...overrides,
  };
}

describe("qualificationScore", () => {
  it("does not count hardcoded known_incident or measurement_changed", () => {
    const base = qualificationScore(gates());
    expect(base).toBe(1);
    expect(qualificationScore(gates({ known_incident: true, measurement_changed: true }))).toBe(base);
  });

  it("names event-count volume min_volume", () => {
    const evaluated = evaluateGates({
      suspectedScope: ["src/components/composer.tsx"],
      surface,
      sampleSize: 12,
      bucketCount: 6,
      minSample: 12,
      minBuckets: 6,
      roadmapRelevant: true,
    });
    expect(evaluated.min_volume).toBe(true);
    expect(evaluated).not.toHaveProperty("multi_user");
  });
});
