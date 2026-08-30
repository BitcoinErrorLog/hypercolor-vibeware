import { afterEach, describe, expect, it } from "vitest";
import { hourIso, MIN_SAMPLE, runDetectors } from "../src/detectors.js";
import { isForbiddenPath } from "../src/scope.js";
import { parseSurface } from "../src/surfaces.js";
import {
  allowlistedEvent,
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

const NOW = new Date("2026-08-30T22:00:00.000Z");

async function setup() {
  harness = await createTestApp(testConfig, { now: () => NOW });
  return harness;
}

async function postEvent(app: Harness["app"], overrides: Record<string, unknown>) {
  const res = await app.request("/v1/evidence", {
    method: "POST",
    headers: ingestHeaders(),
    body: JSON.stringify(allowlistedEvent(overrides)),
  });
  const body = (await res.json()) as { accepted: boolean; reason?: string; id?: string };
  expect(body, JSON.stringify(body)).toMatchObject({ accepted: true });
  return body.id as string;
}

function occurred(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
}

async function plantOnboardingSessionPath(db: Harness["db"]) {
  const rows = await db.query<{ manifest: unknown }>(
    `SELECT manifest FROM vibeware_surfaces WHERE id = 'hc-onboarding-ui'`,
  );
  const surface = parseSurface({ id: "hc-onboarding-ui", owner: "hypercolor", manifest: rows[0]?.manifest });
  const manifest =
    typeof rows[0]?.manifest === "string" ? JSON.parse(rows[0].manifest) : (rows[0]?.manifest as Record<string, unknown>);
  const scope = manifest.scope as { writable_paths: string[] };
  scope.writable_paths = [...surface.writable_paths, "src/services/link/session.ts"];
  await db.query(`UPDATE vibeware_surfaces SET manifest = $1::jsonb WHERE id = $2`, [
    JSON.stringify(manifest),
    "hc-onboarding-ui",
  ]);
}

async function seedOnboardingSpike(app: Harness["app"]) {
  const ids: string[] = [];
  for (let hour = 1; hour <= 6; hour += 1) {
    for (let n = 0; n < 2; n += 1) {
      ids.push(
        await postEvent(app, {
          event_id: `evt_ab_recent_${hour}_${n}`,
          event_type: "app.onboarding.abandoned",
          surface_id: "hc-onboarding-ui",
          occurred_at: occurred(hour),
          payload: { step: "welcome" },
        }),
      );
    }
  }
  for (let hour = 8; hour <= 13; hour += 1) {
    ids.push(
      await postEvent(app, {
        event_id: `evt_ab_base_${hour}`,
        event_type: "app.onboarding.abandoned",
        surface_id: "hc-onboarding-ui",
        occurred_at: occurred(hour),
        payload: { step: "enable" },
      }),
    );
    for (let n = 0; n < 3; n += 1) {
      ids.push(
        await postEvent(app, {
          event_id: `evt_state_base_${hour}_${n}`,
          event_type: "app.onboarding.state",
          surface_id: "hc-onboarding-ui",
          occurred_at: occurred(hour),
          payload: { state: "needs-enable" },
        }),
      );
    }
  }
  return ids;
}

async function seedSendFailedSpike(app: Harness["app"]) {
  const ids: string[] = [];
  for (let hour = 1; hour <= 6; hour += 1) {
    for (let n = 0; n < 2; n += 1) {
      ids.push(
        await postEvent(app, {
          event_id: `evt_send_recent_${hour}_${n}`,
          event_type: "app.thread.send_settled",
          surface_id: "hc-thread-ui",
          occurred_at: occurred(hour),
          payload: { channel: "dm", outcome: "failed", kind: "text" },
        }),
      );
    }
  }
  for (let hour = 8; hour <= 13; hour += 1) {
    ids.push(
      await postEvent(app, {
        event_id: `evt_send_base_fail_${hour}`,
        event_type: "app.thread.send_settled",
        surface_id: "hc-thread-ui",
        occurred_at: occurred(hour),
        payload: { channel: "dm", outcome: "failed", kind: "text" },
      }),
    );
    for (let n = 0; n < 3; n += 1) {
      ids.push(
        await postEvent(app, {
          event_id: `evt_send_base_ok_${hour}_${n}`,
          event_type: "app.thread.send_settled",
          surface_id: "hc-thread-ui",
          occurred_at: occurred(hour),
          payload: { channel: "dm", outcome: "sent", kind: "text" },
        }),
      );
    }
  }
  return ids;
}

async function seedEmptyState(app: Harness["app"]) {
  const ids: string[] = [];
  for (let hour = 1; hour <= 6; hour += 1) {
    for (let n = 0; n < 2; n += 1) {
      ids.push(
        await postEvent(app, {
          event_id: `evt_empty_${hour}_${n}`,
          event_type: "app.chat.empty_state",
          surface_id: "hc-chats-ui",
          occurred_at: occurred(hour),
          payload: { kind: "dms" },
        }),
      );
    }
  }
  return ids;
}

async function seedDeclineHeavy(app: Harness["app"]) {
  const ids: string[] = [];
  for (let hour = 1; hour <= 6; hour += 1) {
    for (let n = 0; n < 2; n += 1) {
      ids.push(
        await postEvent(app, {
          event_id: `evt_dec_decline_${hour}_${n}`,
          event_type: "app.request.decision",
          surface_id: "hc-chats-ui",
          occurred_at: occurred(hour),
          payload: { kind: "dm", decision: "decline" },
        }),
      );
    }
  }
  return ids;
}

describe("phase 2 qualification", () => {
  it("detects three fixture clusters and enforces generate/qualify gates", async () => {
    const { app, db } = await setup();
    await plantOnboardingSessionPath(db);
    await seedOnboardingSpike(app);
    const recentSendIds = (await seedSendFailedSpike(app)).filter((id) => id.startsWith("evt_send_recent_"));
    await seedEmptyState(app);

    const detect = await app.request("/v1/problems/detect", {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(detect.status).toBe(200);
    const detected = (await detect.json()) as {
      problems: Array<{
        id: string;
        surface_id: string;
        state: string;
        title: string;
        suspected_scope: string[];
        qualification: {
          gates: { touches_forbidden_boundary: boolean; within_surface_scope: boolean };
          reject_reason?: string;
        };
      }>;
    };
    expect(detected.problems).toHaveLength(3);

    const rejected = detected.problems.find((problem) => problem.surface_id === "hc-onboarding-ui");
    const pendingEmpty = detected.problems.find((problem) => problem.surface_id === "hc-chats-ui");
    const pendingSend = detected.problems.find((problem) => problem.surface_id === "hc-thread-ui");
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.suspected_scope).toContain("src/services/link/session.ts");
    expect(rejected?.qualification.gates.touches_forbidden_boundary).toBe(true);
    expect(rejected?.qualification.reject_reason).toBe("validation_failed");
    expect(isForbiddenPath("src/services/link/session.ts")).toBe(true);
    expect(isForbiddenPath("SRC/Services/Link/Session.TS")).toBe(true);
    expect(pendingEmpty?.state).toBe("pending_qualify");
    expect(pendingSend?.state).toBe("pending_qualify");
    expect(pendingSend?.suspected_scope).toEqual([
      "src/components/thread-view.tsx",
      "src/components/composer.tsx",
      "src/components/message-bubble.tsx",
    ]);

    const transitions = await db.query<{ object_id: string; from_state: string | null; to_state: string; reason: string | null }>(
      `SELECT object_id, from_state, to_state, reason FROM state_transitions ORDER BY id`,
    );
    expect(transitions.some((row) => row.to_state === "detected")).toBe(true);
    expect(transitions.some((row) => row.object_id === rejected?.id && row.to_state === "rejected" && row.reason === "validation_failed")).toBe(
      true,
    );

    const generatePending = await app.request(`/v1/problems/${pendingSend?.id}/generate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(generatePending.status).toBe(403);
    expect(await generatePending.json()).toEqual({ reason: "unqualified" });

    const generateRejected = await app.request(`/v1/problems/${rejected?.id}/generate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(generateRejected.status).toBe(403);
    expect(await generateRejected.json()).toEqual({ reason: "unqualified" });

    const qualifyForbidden = await app.request(`/v1/problems/${rejected?.id}/qualify`, {
      method: "POST",
      headers: { ...Object.fromEntries(internalHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ qualified: true, actor: "owner", reason: "looks fine" }),
    });
    expect(qualifyForbidden.status).toBe(403);
    expect(await qualifyForbidden.json()).toEqual({ reason: "validation_failed" });

    const qualify = await app.request(`/v1/problems/${pendingSend?.id}/qualify`, {
      method: "POST",
      headers: { ...Object.fromEntries(internalHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ qualified: true, actor: "owner", reason: "repeated send failures" }),
    });
    expect(qualify.status).toBe(200);
    expect(await qualify.json()).toMatchObject({ id: pendingSend?.id, state: "qualified" });

    const generated = await app.request(`/v1/problems/${pendingSend?.id}/generate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(generated.status).toBe(201);
    const candidate = (await generated.json()) as {
      id: string;
      problem_id: string;
      state: string;
      artifact: {
        surface: string;
        evidence_refs: string[];
        allowed_paths: string[];
        forbidden_paths: string[];
        budgets: {
          max_initial_percent: number;
          requires_human_for_percent_over: number;
          minimum_exposure_hours: number;
          max_new_dependencies: number;
        };
      };
    };
    expect(candidate.state).toBe("request_ready");
    expect(candidate.problem_id).toBe(pendingSend?.id);
    expect(candidate.artifact.surface).toBe("hc-thread-ui");
    expect(candidate.artifact.allowed_paths).toEqual([
      "src/components/thread-view.tsx",
      "src/components/composer.tsx",
      "src/components/message-bubble.tsx",
    ]);
    expect(candidate.artifact.forbidden_paths).toEqual(
      expect.arrayContaining([
        "src/services/link/session.ts",
        "src/services/KeyStore.ts",
        "vibeware.yaml",
        ".github/**",
        "src/services/payments/**",
      ]),
    );
    expect(candidate.artifact.budgets).toMatchObject({
      max_initial_percent: 10,
      requires_human_for_percent_over: 25,
      minimum_exposure_hours: 48,
      max_new_dependencies: 0,
    });
    expect(candidate.artifact.evidence_refs.sort()).toEqual(recentSendIds.sort());
    expect(candidate.artifact.evidence_refs.every((id) => typeof id === "string")).toBe(true);
    const artifactJson = JSON.stringify(candidate.artifact);
    expect(artifactJson).not.toContain("payload");
    expect(artifactJson).not.toContain('"failed"');
    expect(artifactJson).not.toContain('"kind"');

    const stored = await db.query<{ artifact: unknown; state: string }>(
      `SELECT artifact, state FROM candidates WHERE id = $1`,
      [candidate.id],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe("request_ready");

    const page = await app.request("/", { headers: dashboardHeaders() });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(pendingSend?.title ?? "missing");
    expect(html).toContain("hc-thread-ui");
    expect(html).toContain("qualified");
    expect(html).not.toContain("SELECT id FROM evidence");
    expect(html).not.toContain("secret message");
  });

  it("rejects detect and qualify without the internal token", async () => {
    const { app } = await setup();
    const detect = await app.request("/v1/problems/detect", { method: "POST", headers: dashboardHeaders() });
    expect(detect.status).toBe(401);
    const qualify = await app.request("/v1/problems/missing/qualify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ qualified: true, actor: "owner", reason: "no" }),
    });
    expect(qualify.status).toBe(401);
  });

  it("includes evidence refs only for the problem surface", async () => {
    const { app } = await setup();
    const recentSendIds = (await seedSendFailedSpike(app)).filter((id) => id.startsWith("evt_send_recent_"));
    const detect = await app.request("/v1/problems/detect", { method: "POST", headers: internalHeaders() });
    expect(detect.status).toBe(200);
    const detected = (await detect.json()) as { problems: Array<{ id: string; surface_id: string }> };
    const pendingSend = detected.problems.find((problem) => problem.surface_id === "hc-thread-ui");
    expect(pendingSend).toBeDefined();

    const otherSurfaceId = await postEvent(app, {
      event_id: "evt_send_other_surface",
      event_type: "app.thread.send_settled",
      surface_id: "hc-chats-ui",
      occurred_at: occurred(1),
      payload: { channel: "dm", outcome: "failed", kind: "text" },
    });

    const qualify = await app.request(`/v1/problems/${pendingSend?.id}/qualify`, {
      method: "POST",
      headers: { ...Object.fromEntries(internalHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ qualified: true, actor: "owner", reason: "surface-scoped refs" }),
    });
    expect(qualify.status).toBe(200);

    const generated = await app.request(`/v1/problems/${pendingSend?.id}/generate`, {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(generated.status).toBe(201);
    const candidate = (await generated.json()) as { artifact: { evidence_refs: string[] } };
    expect(candidate.artifact.evidence_refs).not.toContain(otherSurfaceId);
    expect(candidate.artifact.evidence_refs.sort()).toEqual(recentSendIds.sort());
  });

  it("detects decline-heavy request decisions from the projection", async () => {
    const { app } = await setup();
    await seedDeclineHeavy(app);
    const detect = await app.request("/v1/problems/detect", { method: "POST", headers: internalHeaders() });
    const body = (await detect.json()) as { problems: Array<{ detector_key: string; state: string; surface_id: string }> };
    expect(body.problems).toEqual([
      expect.objectContaining({
        detector_key: "app.request.decision.decline_heavy",
        surface_id: "hc-chats-ui",
        state: "pending_qualify",
      }),
    ]);
  });
});

describe("detectors on projection rows", () => {
  const surface = parseSurface({
    id: "hc-chats-ui",
    owner: "hypercolor",
    manifest: {
      scope: { writable_paths: ["src/components/chats-page.tsx"], forbidden_paths: [] },
      exposure: { max_initial_percent: 10, requires_human_for_percent_over: 25 },
      selection: { minimum_exposure_hours: 48 },
    },
  });
  const onboarding = parseSurface({
    id: "hc-onboarding-ui",
    owner: "hypercolor",
    manifest: {
      scope: {
        writable_paths: ["src/components/welcome-page.tsx"],
        forbidden_paths: ["src/services/link/session.ts"],
      },
      exposure: { max_initial_percent: 10, requires_human_for_percent_over: 25 },
      selection: { minimum_exposure_hours: 48 },
    },
  });
  const thread = parseSurface({
    id: "hc-thread-ui",
    owner: "hypercolor",
    manifest: {
      scope: { writable_paths: ["src/components/composer.tsx"], forbidden_paths: [] },
      exposure: { max_initial_percent: 10, requires_human_for_percent_over: 25 },
      selection: { minimum_exposure_hours: 48 },
    },
  });

  it("requires six projection buckets before comparing rates", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      hour: hourIso(new Date(NOW.getTime() - (index + 1) * 3600_000)),
      event_type: "app.onboarding.abandoned",
      payload_class: "welcome",
      event_count: MIN_SAMPLE,
    }));
    expect(runDetectors(rows, [onboarding], NOW)).toEqual([]);
  });

  it("compares a 7-day baseline when enough distinct days exist", () => {
    const rows = [];
    for (let hour = 1; hour <= 6; hour += 1) {
      rows.push({
        hour: hourIso(new Date(NOW.getTime() - hour * 3600_000)),
        event_type: "app.onboarding.abandoned",
        payload_class: "welcome",
        event_count: 4,
      });
      rows.push({
        hour: hourIso(new Date(NOW.getTime() - (7 * 24 + hour) * 3600_000)),
        event_type: "app.onboarding.abandoned",
        payload_class: "welcome",
        event_count: 1,
      });
      rows.push({
        hour: hourIso(new Date(NOW.getTime() - (7 * 24 + hour) * 3600_000)),
        event_type: "app.onboarding.state",
        payload_class: "live",
        event_count: 3,
      });
    }
    const hits = runDetectors(rows, [onboarding], NOW);
    expect(hits.map((hit) => hit.detectorKey)).toEqual(["app.onboarding.abandoned.rate"]);
    expect(hits[0]?.metrics.current_rate).toBe(1);
    expect(hits[0]?.metrics.baseline_rate).toBe(0.25);
  });

  it("does not fire empty-state when chat routes are viewed in the same hours", () => {
    const rows = [];
    for (let hour = 1; hour <= 6; hour += 1) {
      const hourValue = hourIso(new Date(NOW.getTime() - hour * 3600_000));
      rows.push({
        hour: hourValue,
        event_type: "app.chat.empty_state",
        payload_class: "dms",
        event_count: 3,
      });
      rows.push({
        hour: hourValue,
        event_type: "app.route.viewed",
        payload_class: "chat|chats",
        event_count: 3,
      });
    }
    expect(runDetectors(rows, [surface], NOW)).toEqual([]);
  });

  it("fires thread send failure by kind against other hours when span is under 7 days", () => {
    const rows = [];
    for (let hour = 1; hour <= 6; hour += 1) {
      rows.push({
        hour: hourIso(new Date(NOW.getTime() - hour * 3600_000)),
        event_type: "app.thread.send_settled",
        payload_class: "dm|failed|attachment",
        event_count: 3,
      });
      rows.push({
        hour: hourIso(new Date(NOW.getTime() - (hour + 8) * 3600_000)),
        event_type: "app.thread.send_settled",
        payload_class: "dm|sent|attachment",
        event_count: 3,
      });
    }
    const hits = runDetectors(rows, [thread], NOW);
    expect(hits).toEqual([
      expect.objectContaining({
        detectorKey: "app.thread.send_settled.failed.attachment",
        surfaceId: "hc-thread-ui",
      }),
    ]);
  });
});
