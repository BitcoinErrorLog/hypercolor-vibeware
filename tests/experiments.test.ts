import { afterEach, describe, expect, it } from "vitest";
import {
  assignmentUnit,
  buildDecisionInput,
  enforcePercentLimits,
  jsonHasBannedKey,
  parseCandidateSha,
  parseCreateExperimentBody,
  parseHttpsOrigin,
} from "../src/experiments.js";
import { parseSurface } from "../src/surfaces.js";
import {
  closeTestApp,
  createTestApp,
  dashboardHeaders,
  ingestHeaders,
  internalHeaders,
  testConfig,
} from "./harness.js";

type Harness = Awaited<ReturnType<typeof createTestApp>>;

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await closeTestApp(harness.db);
    harness = undefined;
  }
});

const NOW = new Date("2026-08-31T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const VALID_SHA = "a".repeat(40);
const VALID_ORIGIN = "https://hypercolor-web.vercel.app";
const CANDIDATE_ID = "cand_ready";
const PUBKY_SHAPED = "y".repeat(52);
const RECOVERY_SHAPED = "A".repeat(43);
const CREDENTIAL_URL = "https://user:pass@homeserver.example";

function hexKey(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function firstKey(experimentId: string, predicate: (unit: number) => boolean): string {
  for (let i = 0; i < 10_000; i += 1) {
    const key = hexKey(i);
    if (predicate(assignmentUnit(experimentId, key))) return key;
  }
  throw new Error("no matching cohort key");
}

function jsonHeaders(): Headers {
  const headers = internalHeaders();
  headers.set("content-type", "application/json");
  return headers;
}

async function patchSurface(
  db: Harness["db"],
  id: string,
  patch: {
    exposure?: { max_initial_percent?: number; requires_human_for_percent_over?: number };
    selection?: { minimum_exposure_hours?: number };
  },
) {
  const rows = await db.query<{ manifest: unknown }>(`SELECT manifest FROM vibeware_surfaces WHERE id = $1`, [id]);
  const manifest =
    typeof rows[0]?.manifest === "string"
      ? JSON.parse(rows[0].manifest)
      : { ...(rows[0]?.manifest as Record<string, unknown>) };
  if (patch.exposure) {
    manifest.exposure = { ...(manifest.exposure as Record<string, unknown> | undefined), ...patch.exposure };
  }
  if (patch.selection) {
    manifest.selection = { ...(manifest.selection as Record<string, unknown> | undefined), ...patch.selection };
  }
  await db.query(`UPDATE vibeware_surfaces SET manifest = $1::jsonb WHERE id = $2`, [JSON.stringify(manifest), id]);
}

async function setup(now: () => Date = () => NOW) {
  harness = await createTestApp(testConfig, { now });
  await harness.db.query(
    `INSERT INTO problems (id, surface_id, title, summary, state)
     VALUES ($1, $2, $3, $4, $5)`,
    ["prob_ready", "hc-thread-ui", "send failures", "fixture", "qualified"],
  );
  await harness.db.query(
    `INSERT INTO candidates (id, problem_id, state, base_sha, artifact)
     VALUES ($1, $2, 'request_ready', 'unresolved', $3::jsonb)`,
    [
      CANDIDATE_ID,
      "prob_ready",
      JSON.stringify({
        surface: "hc-thread-ui",
        primary_metric: "hijacked_from_candidate",
        evidence_refs: [],
      }),
    ],
  );
  return harness;
}

async function createExperiment(
  app: Harness["app"],
  overrides: Record<string, unknown> = {},
  headers: Headers = jsonHeaders(),
) {
  return app.request("/v1/experiments", {
    method: "POST",
    headers,
    body: JSON.stringify({
      candidate_id: CANDIDATE_ID,
      candidate_sha: VALID_SHA,
      candidate_origin: VALID_ORIGIN,
      ...overrides,
    }),
  });
}

describe("candidate_build registration", () => {
  it("rejects non-https origins and branch-latest shas", () => {
    expect(parseHttpsOrigin("http://hypercolor-web.vercel.app")).toBeNull();
    expect(parseHttpsOrigin("https://hypercolor-web.vercel.app/path")).toBeNull();
    expect(parseHttpsOrigin(VALID_ORIGIN)).toBe(VALID_ORIGIN);
    expect(parseHttpsOrigin(`${VALID_ORIGIN}/`)).toBe(VALID_ORIGIN);
    expect(parseCandidateSha("latest")).toBeNull();
    expect(parseCandidateSha("origin/main")).toBeNull();
    expect(parseCandidateSha("deadbeef")).toBeNull();
    expect(parseCandidateSha(VALID_SHA.toUpperCase())).toBe(VALID_SHA);
  });

  it("stores the origin string and does not accept http", async () => {
    const { app, db } = await setup();
    const created = await createExperiment(app);
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      candidate_build: { sha: string; origin: string };
      killed: boolean;
      percent: number;
    };
    expect(body.candidate_build).toEqual({ sha: VALID_SHA, origin: VALID_ORIGIN });
    expect(body.percent).toBe(10);
    expect(body.killed).toBe(false);

    const stored = await db.query<{ config: unknown; killed: boolean }>(
      `SELECT config, killed FROM experiments WHERE id = $1`,
      [body.id],
    );
    const config =
      typeof stored[0]?.config === "string" ? JSON.parse(stored[0].config) : stored[0]?.config;
    expect(config).toMatchObject({
      percent: 10,
      candidate_build: { sha: VALID_SHA, origin: VALID_ORIGIN },
    });
    expect(config).not.toHaveProperty("killed");
    expect(stored[0]?.killed).toBe(false);

    const httpOrigin = await createExperiment(app, { candidate_origin: "http://localhost:3000" });
    expect(httpOrigin.status).toBe(400);
    expect(await httpOrigin.json()).toEqual({ reason: "invalid_origin" });

    const latest = await createExperiment(app, { candidate_sha: "latest" });
    expect(latest.status).toBe(400);
    expect(await latest.json()).toEqual({ reason: "invalid_sha" });
  });

  it("returns 403 when the candidate is missing or not request_ready", async () => {
    const { app, db } = await setup();
    const missing = await createExperiment(app, { candidate_id: "cand_missing" });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ reason: "candidate_not_ready" });

    await db.query(`UPDATE candidates SET state = 'draft' WHERE id = $1`, [CANDIDATE_ID]);
    const notReady = await createExperiment(app);
    expect(notReady.status).toBe(403);
    expect(await notReady.json()).toEqual({ reason: "candidate_not_ready" });
  });
});

describe("percent gates", () => {
  it("rejects percent 11 without actor/reason and percent 26 even with human", async () => {
    const { app } = await setup();
    const noHuman = await createExperiment(app, { percent: 11 });
    expect(noHuman.status).toBe(403);
    expect(await noHuman.json()).toEqual({ reason: "percent_requires_human" });

    const overCap = await createExperiment(app, {
      percent: 26,
      actor: "owner",
      reason: "want more traffic",
    });
    expect(overCap.status).toBe(403);
    expect(await overCap.json()).toEqual({ reason: "percent_over_cap" });

    const allowed = await createExperiment(app, {
      percent: 25,
      actor: "owner",
      reason: "v1 human path up to cap",
    });
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toMatchObject({ percent: 25, killed: false });
  });

  it("honors a tighter per-surface max_initial_percent", async () => {
    const { app, db } = await setup();
    await patchSurface(db, "hc-thread-ui", { exposure: { max_initial_percent: 5 } });

    const implicit = await createExperiment(app);
    expect(implicit.status).toBe(403);
    expect(await implicit.json()).toEqual({ reason: "percent_requires_human" });

    const explicit = await createExperiment(app, { percent: 10 });
    expect(explicit.status).toBe(403);
    expect(await explicit.json()).toEqual({ reason: "percent_requires_human" });

    const within = await createExperiment(app, { percent: 5 });
    expect(within.status).toBe(201);
    expect(await within.json()).toMatchObject({ percent: 5, killed: false });

    const withHuman = await createExperiment(app, {
      percent: 10,
      actor: "owner",
      reason: "tight surface still allows human up to the v1 cap",
    });
    expect(withHuman.status).toBe(201);
    expect(await withHuman.json()).toMatchObject({ percent: 10, killed: false });
  });

  it("honors a tighter per-surface requires_human_for_percent_over", async () => {
    const { app, db } = await setup();
    await patchSurface(db, "hc-thread-ui", { exposure: { requires_human_for_percent_over: 15 } });

    const overSurfaceCap = await createExperiment(app, {
      percent: 16,
      actor: "owner",
      reason: "above this surface cap",
    });
    expect(overSurfaceCap.status).toBe(403);
    expect(await overSurfaceCap.json()).toEqual({ reason: "percent_over_cap" });

    const atSurfaceCap = await createExperiment(app, {
      percent: 15,
      actor: "owner",
      reason: "surface hard cap",
    });
    expect(atSurfaceCap.status).toBe(201);
    expect(await atSurfaceCap.json()).toMatchObject({ percent: 15 });
  });

  it("cannot raise the global v1 cap through a looser surface", async () => {
    const { app, db } = await setup();
    await patchSurface(db, "hc-thread-ui", {
      exposure: { max_initial_percent: 20, requires_human_for_percent_over: 40 },
    });

    const noHuman = await createExperiment(app, { percent: 11 });
    expect(noHuman.status).toBe(403);
    expect(await noHuman.json()).toEqual({ reason: "percent_requires_human" });

    const overGlobal = await createExperiment(app, {
      percent: 26,
      actor: "owner",
      reason: "surface cannot raise v1",
    });
    expect(overGlobal.status).toBe(403);
    expect(await overGlobal.json()).toEqual({ reason: "percent_over_cap" });
  });

  it("parseCreateExperimentBody applies supplied surface limits", () => {
    const body = {
      candidate_id: CANDIDATE_ID,
      candidate_sha: VALID_SHA,
      candidate_origin: VALID_ORIGIN,
      percent: 10,
    };
    expect(parseCreateExperimentBody(body).ok).toBe(true);
    expect(parseCreateExperimentBody(body, { max_initial_percent: 5, requires_human_for_percent_over: 25 })).toEqual({
      ok: false,
      reason: "percent_requires_human",
      status: 403,
    });
    expect(
      enforcePercentLimits(10, false, { max_initial_percent: 5, requires_human_for_percent_over: 25 }),
    ).toEqual({ ok: false, reason: "percent_requires_human", status: 403 });
    expect(
      enforcePercentLimits(16, true, { max_initial_percent: 10, requires_human_for_percent_over: 15 }),
    ).toEqual({ ok: false, reason: "percent_over_cap", status: 403 });
  });
});

describe("assignment", () => {
  it("is stable for the same experiment and cohort", async () => {
    const { app } = await setup();
    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };
    const key = hexKey(1);
    const first = await app.request(`/v1/experiments/${experiment.id}/assignment?cohort_key=${key}`, {
      headers: internalHeaders(),
    });
    const second = await app.request(`/v1/experiments/${experiment.id}/assignment?cohort_key=${key}`, {
      headers: internalHeaders(),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { bucket: string; experiment_id: string; killed: boolean };
    const b = (await second.json()) as { bucket: string };
    expect(a).toEqual({
      bucket: assignmentUnit(experiment.id, key) < 10 ? "candidate" : "control",
      experiment_id: experiment.id,
      killed: false,
    });
    expect(b.bucket).toBe(a.bucket);
  });

  it("splits cohorts and keeps most of a 10 percent roll on control", async () => {
    const { app } = await setup();
    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };
    const candidateKey = firstKey(experiment.id, (unit) => unit < 10);
    const controlKey = firstKey(experiment.id, (unit) => unit >= 10);

    const candidate = await app.request(
      `/v1/experiments/${experiment.id}/assignment?cohort_key=${candidateKey}`,
      { headers: internalHeaders() },
    );
    const control = await app.request(
      `/v1/experiments/${experiment.id}/assignment?cohort_key=${controlKey}`,
      { headers: internalHeaders() },
    );
    expect(await candidate.json()).toMatchObject({ bucket: "candidate", killed: false });
    expect(await control.json()).toMatchObject({ bucket: "control", killed: false });

    const units = Array.from({ length: 200 }, (_, i) => assignmentUnit(experiment.id, hexKey(i)));
    const candidateCount = units.filter((unit) => unit < 10).length;
    expect(candidateCount).toBeGreaterThan(0);
    expect(candidateCount).toBeLessThan(units.length / 2);
    for (const key of [hexKey(0), hexKey(7), hexKey(42)]) {
      const res = await app.request(`/v1/experiments/${experiment.id}/assignment?cohort_key=${key}`, {
        headers: internalHeaders(),
      });
      expect(await res.json()).toMatchObject({
        bucket: assignmentUnit(experiment.id, key) < 10 ? "candidate" : "control",
      });
    }
  });

  it("returns control for every cohort after kill", async () => {
    const { app, db } = await setup();
    const created = await createExperiment(app, { killed: true, candidate_build: { killed: true } });
    const experiment = (await created.json()) as { id: string; killed: boolean };
    expect(experiment.killed).toBe(false);

    const candidateKey = firstKey(experiment.id, (unit) => unit < 10);
    const before = await app.request(
      `/v1/experiments/${experiment.id}/assignment?cohort_key=${candidateKey}`,
      { headers: internalHeaders() },
    );
    expect(await before.json()).toMatchObject({ bucket: "candidate", killed: false });

    const kill = await app.request(`/v1/experiments/${experiment.id}/kill`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(kill.status).toBe(200);
    expect(await kill.json()).toMatchObject({ id: experiment.id, state: "killed", killed: true });

    const afterSame = await app.request(
      `/v1/experiments/${experiment.id}/assignment?cohort_key=${candidateKey}`,
      { headers: internalHeaders() },
    );
    const afterOther = await app.request(
      `/v1/experiments/${experiment.id}/assignment?cohort_key=${hexKey(99)}`,
      { headers: internalHeaders() },
    );
    expect(await afterSame.json()).toEqual({
      bucket: "control",
      experiment_id: experiment.id,
      killed: true,
    });
    expect(await afterOther.json()).toMatchObject({ bucket: "control", killed: true });

    const transitions = await db.query<{ to_state: string; actor: string }>(
      `SELECT to_state, actor FROM state_transitions WHERE object_type = 'experiment' AND object_id = $1`,
      [experiment.id],
    );
    expect(transitions.some((row) => row.to_state === "killed" && row.actor === "kill_switch")).toBe(true);

    const stored = await db.query<{ config: unknown; killed: boolean }>(
      `SELECT config, killed FROM experiments WHERE id = $1`,
      [experiment.id],
    );
    const config =
      typeof stored[0]?.config === "string" ? JSON.parse(stored[0].config) : stored[0]?.config;
    expect(stored[0]?.killed).toBe(true);
    expect(config.candidate_build).toEqual({ sha: VALID_SHA, origin: VALID_ORIGIN });
    expect(config.candidate_build).not.toHaveProperty("killed");
  });
});

describe("banned decision values", () => {
  it("rejects banned keys and ingest-shaped values", () => {
    expect(jsonHasBannedKey({ token: "x" })).toBe(true);
    expect(jsonHasBannedKey({ note: PUBKY_SHAPED })).toBe(true);
    expect(jsonHasBannedKey({ note: RECOVERY_SHAPED })).toBe(true);
    expect(jsonHasBannedKey({ note: CREDENTIAL_URL })).toBe(true);
    expect(jsonHasBannedKey({ note: "https://homeserver.example/callback" })).toBe(true);
    expect(jsonHasBannedKey({ surface_id: "hc-thread-ui", primary_metric: "send_settle_success" })).toBe(false);
  });
});

describe("evaluator", () => {
  it("reads projection counts only and ignores candidate metric overrides", async () => {
    let current = NOW;
    const { app, db } = await setup(() => current);
    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };

    current = new Date(NOW.getTime() + 48 * HOUR_MS);
    const evaluated = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(evaluated.status).toBe(201);
    const body = (await evaluated.json()) as {
      id: string;
      experiment_id: string;
      decision_input: Record<string, unknown>;
    };
    expect(body.experiment_id).toBe(experiment.id);
    expect(body.decision_input.primary_metric).toBe("send_settle_success");
    expect(body.decision_input.primary_metric).not.toBe("hijacked_from_candidate");
    expect(jsonHasBannedKey(body.decision_input)).toBe(false);
    expect(JSON.stringify(body.decision_input)).not.toMatch(/body|recovery|token|pubky|secret|payment/i);

    const stored = await db.query<{ result: unknown }>(`SELECT result FROM evaluations WHERE id = $1`, [body.id]);
    const result = typeof stored[0]?.result === "string" ? JSON.parse(stored[0].result) : stored[0]?.result;
    expect(result).toEqual({ decision_input: body.decision_input });
    expect(jsonHasBannedKey(result)).toBe(false);

    const evidenceReads = await db.query<{ id: string }>(`SELECT id FROM evidence`);
    expect(evidenceReads).toEqual([]);

    const surface = parseSurface({
      id: "hc-thread-ui",
      owner: "hypercolor",
      manifest: { selection: { primary_metric: "send_settle_success" } },
    });
    const fromProjection = buildDecisionInput({
      experimentId: experiment.id,
      surface,
      killed: false,
      percent: 10,
      rows: [],
      now: NOW,
    });
    expect(fromProjection.counts.events_total).toBe(0);
    expect(fromProjection.primary_metric).toBe("send_settle_success");
    expect(jsonHasBannedKey(fromProjection)).toBe(false);
  });

  it("rejects evaluate before minimum_exposure_hours", async () => {
    let current = NOW;
    const { app } = await setup(() => current);
    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };

    const tooEarly = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(tooEarly.status).toBe(403);
    expect(await tooEarly.json()).toEqual({ reason: "minimum_exposure_hours" });

    current = new Date(NOW.getTime() + 47 * HOUR_MS);
    const stillEarly = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(stillEarly.status).toBe(403);
    expect(await stillEarly.json()).toEqual({ reason: "minimum_exposure_hours" });

    current = new Date(NOW.getTime() + 48 * HOUR_MS);
    const ready = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(ready.status).toBe(201);
  });

  it("reads minimum_exposure_hours from the surface manifest", async () => {
    let current = NOW;
    const { app, db } = await setup(() => current);
    await patchSurface(db, "hc-thread-ui", { selection: { minimum_exposure_hours: 72 } });
    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };

    current = new Date(NOW.getTime() + 48 * HOUR_MS);
    const atDefault = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(atDefault.status).toBe(403);
    expect(await atDefault.json()).toEqual({ reason: "minimum_exposure_hours" });

    current = new Date(NOW.getTime() + 72 * HOUR_MS);
    const atSurface = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(atSurface.status).toBe(201);
  });

  it("evaluate reads the projection view, not a clocked evidence aggregate", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    let current = past;
    const { app, db } = await setup(() => current);
    await db.query(
      `INSERT INTO evidence (id, surface_id, type, payload, occurred_at, model_allowed, expires_at)
       VALUES
         (
           'old_clocked',
           'hc-thread-ui',
           'app.error.coarse',
           '{"code":"network","surface":"thread"}'::jsonb,
           '2020-01-01T00:00:00.000Z'::timestamptz,
           true,
           '2020-01-15T00:00:00.000Z'::timestamptz
         ),
         (
           'live_view',
           'hc-thread-ui',
           'app.error.coarse',
           '{"code":"auth","surface":"thread"}'::jsonb,
           now(),
           true,
           now() + interval '14 days'
         )`,
    );
    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };
    current = new Date(past.getTime() + 48 * HOUR_MS);
    const evaluated = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(evaluated.status).toBe(201);
    const body = (await evaluated.json()) as {
      decision_input: { counts: { events_total: number; app_error_coarse: number } };
    };
    expect(body.decision_input.counts.events_total).toBe(1);
    expect(body.decision_input.counts.app_error_coarse).toBe(1);
  });
});

describe("auth", () => {
  it("uses internal for mutate and assignment; dashboard may read status", async () => {
    const { app } = await setup();
    const ingestCreate = await createExperiment(app, {}, ingestHeaders());
    expect(ingestCreate.status).toBe(401);

    const dashboardCreate = await createExperiment(app, {}, dashboardHeaders());
    expect(dashboardCreate.status).toBe(401);

    const created = await createExperiment(app);
    const experiment = (await created.json()) as { id: string };

    const dashboardAssign = await app.request(
      `/v1/experiments/${experiment.id}/assignment?cohort_key=${hexKey(1)}`,
      { headers: dashboardHeaders() },
    );
    expect(dashboardAssign.status).toBe(401);

    const dashboardKill = await app.request(`/v1/experiments/${experiment.id}/kill`, {
      method: "POST",
      headers: dashboardHeaders(),
    });
    expect(dashboardKill.status).toBe(401);

    const dashboardEvaluate = await app.request(`/v1/experiments/${experiment.id}/evaluate`, {
      method: "POST",
      headers: dashboardHeaders(),
    });
    expect(dashboardEvaluate.status).toBe(401);

    const dashboardStatus = await app.request(`/v1/experiments/${experiment.id}`, {
      headers: dashboardHeaders(),
    });
    expect(dashboardStatus.status).toBe(200);
    expect(await dashboardStatus.json()).toMatchObject({
      id: experiment.id,
      killed: false,
      candidate_build: { sha: VALID_SHA, origin: VALID_ORIGIN },
    });

    const internalStatus = await app.request(`/v1/experiments/${experiment.id}`, {
      headers: internalHeaders(),
    });
    expect(internalStatus.status).toBe(200);
  });
});
