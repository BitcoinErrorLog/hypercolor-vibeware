import { afterEach, describe, expect, it } from "vitest";
import { gcExpiredEvidence } from "../src/gc.js";
import { readProjection, serializeProjection } from "../src/projection.js";
import {
  allowlistedEvent,
  closeTestApp,
  createTestApp,
  dashboardHeaders,
  ingestHeaders,
  internalHeaders,
  TEST_COHORT_KEY,
  TEST_DASHBOARD_TOKEN,
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

async function setup() {
  harness = await createTestApp();
  return harness;
}

async function dumpEvidence(db: Harness["db"]) {
  return db.query(`SELECT id, type, payload, model_allowed FROM evidence`);
}

describe("evidence ingest and projection", () => {
  it("allowlisted event persists and appears in projection", async () => {
    const { app, db } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(allowlistedEvent({ event_id: "evt_allow_1" })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, id: "evt_allow_1" });

    const stored = await dumpEvidence(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "evt_allow_1",
      type: "app.chat.empty_state",
      model_allowed: true,
    });

    const projection = await app.request("/v1/projection", { headers: dashboardHeaders() });
    expect(projection.status).toBe(200);
    const body = (await projection.json()) as {
      window_days: number;
      rows: Array<{ event_type: string; payload_class: string; event_count: number }>;
    };
    expect(body.window_days).toBe(14);
    expect(body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "app.chat.empty_state",
          payload_class: "dms",
          event_count: 1,
        }),
      ]),
    );
  });

  it("planted body secret message is dropped from evidence and projection", async () => {
    const { app, db } = await setup();
    const planted = allowlistedEvent({
      event_type: "app.route.viewed",
      payload: { route: "/chats", from_route: "/", body: "secret message" },
    });
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(planted),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "banned_key" });

    const stored = JSON.stringify(await dumpEvidence(db));
    expect(stored).not.toContain("secret message");
    expect(await dumpEvidence(db)).toEqual([]);

    const projection = await app.request("/v1/projection", { headers: dashboardHeaders() });
    const body = await projection.text();
    expect(body).not.toContain("secret message");
    const parsed = JSON.parse(body) as { rows: unknown[] };
    expect(parsed.rows).toEqual([]);
  });

  it("payload with pubky-looking string is dropped", async () => {
    const { app, db } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(
        allowlistedEvent({
          event_type: "app.route.viewed",
          payload: { route: "y".repeat(52), from_route: "/" },
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "pubky_shaped" });
    expect(await dumpEvidence(db)).toEqual([]);
  });

  it("payload with recovery-code-looking string is dropped", async () => {
    const { app, db } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(
        allowlistedEvent({
          event_type: "app.error.coarse",
          payload: { code: "A".repeat(43), surface: "composer" },
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "recovery_shaped" });
    expect(await dumpEvidence(db)).toEqual([]);
  });

  it("model_allowed=false row never appears in projection", async () => {
    const { app, db } = await setup();
    await db.query(
      `INSERT INTO evidence (id, surface_id, type, payload, occurred_at, model_allowed, expires_at)
       VALUES (
         'hidden_false',
         'hc-chats-ui',
         'app.chat.empty_state',
         '{"kind":"groups"}'::jsonb,
         now(),
         false,
         now() + interval '14 days'
       )`,
    );
    const rows = serializeProjection(await readProjection(db));
    expect(rows).toEqual([]);
    const projection = await app.request("/v1/projection", { headers: dashboardHeaders() });
    const body = (await projection.json()) as { rows: Array<{ payload_class: string }> };
    expect(body.rows).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("groups");
  });

  it("GET /v1/projection without token is 401", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/projection");
    expect(res.status).toBe(401);
  });

  it("POST /v1/problems/:id/generate against unqualified is 403", async () => {
    const { app, db } = await setup();
    await db.query(
      `INSERT INTO problems (id, surface_id, title, summary, state)
       VALUES ('prob_unqualified', 'hc-chats-ui', 'empty dms', 'empty state persists', 'detected')`,
    );
    const res = await app.request("/v1/problems/prob_unqualified/generate", {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ reason: "unqualified" });
  });

  it("unknown event types return 200 unknown_event and are not stored", async () => {
    const { app, db } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(allowlistedEvent({ event_type: "private_message_body" })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "unknown_event" });
    expect(await dumpEvidence(db)).toEqual([]);
  });

  it("gc deletes expired evidence rows", async () => {
    const { db } = await setup();
    await db.query(
      `INSERT INTO evidence (id, surface_id, type, payload, occurred_at, model_allowed, expires_at)
       VALUES (
         'expired_row',
         'hc-chats-ui',
         'app.chat.empty_state',
         '{"kind":"dms"}'::jsonb,
         now() - interval '15 days',
         true,
         now() - interval '1 day'
       )`,
    );
    const deleted = await gcExpiredEvidence(db);
    expect(deleted).toBe(1);
    expect(await dumpEvidence(db)).toEqual([]);
  });

  it("ingest without token is 401", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowlistedEvent()),
    });
    expect(res.status).toBe(401);
  });

  it("dashboard login cookie can read counts and does not dump evidence", async () => {
    const { app } = await setup();
    await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(allowlistedEvent({ cohort_key: TEST_COHORT_KEY })),
    });
    const login = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:8080" },
      body: `token=${encodeURIComponent("test-dashboard-token-32chars")}`,
    });
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    const page = await app.request("/", {
      headers: { cookie, host: "localhost:8080" },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("app.chat.empty_state");
    expect(html).not.toContain("SELECT");
    expect(html).not.toContain("secret message");
    expect(html).toContain("No raw");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects hostile free-text route values and does not persist them", async () => {
    const { app, db } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(
        allowlistedEvent({
          event_type: "app.route.viewed",
          payload: { route: "secret message", from_route: "none" },
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "invalid_payload" });

    const stored = JSON.stringify(await dumpEvidence(db));
    expect(stored).not.toContain("secret message");
    expect(await dumpEvidence(db)).toEqual([]);

    const projection = await app.request("/v1/projection", { headers: dashboardHeaders() });
    const body = await projection.text();
    expect(body).not.toContain("secret message");
    const parsed = JSON.parse(body) as { rows: unknown[] };
    expect(parsed.rows).toEqual([]);
  });

  it("accepts a closed-enum route event", async () => {
    const { app, db } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(
        allowlistedEvent({
          event_id: "evt_route_ok",
          event_type: "app.route.viewed",
          payload: { route: "chats", from_route: "none" },
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, id: "evt_route_ok" });
    expect(await dumpEvidence(db)).toHaveLength(1);
  });

  it("splits dashboard read token from internal mutate token", async () => {
    const { app, db } = await setup();
    await db.query(
      `INSERT INTO problems (id, surface_id, title, summary, state)
       VALUES ('prob_split', 'hc-chats-ui', 'empty dms', 'empty state persists', 'detected')`,
    );

    const dashboardGc = await app.request("/internal/gc", {
      method: "POST",
      headers: dashboardHeaders(),
    });
    expect(dashboardGc.status).toBe(401);

    const dashboardGenerate = await app.request("/v1/problems/prob_split/generate", {
      method: "POST",
      headers: dashboardHeaders(),
    });
    expect(dashboardGenerate.status).toBe(401);

    const ingestGc = await app.request("/internal/gc", {
      method: "POST",
      headers: ingestHeaders(),
    });
    expect(ingestGc.status).toBe(401);

    const internalProjection = await app.request("/v1/projection", { headers: internalHeaders() });
    expect(internalProjection.status).toBe(401);

    const internalGc = await app.request("/internal/gc", {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(internalGc.status).toBe(200);
    expect(await internalGc.json()).toEqual({ deleted: 0 });

    const internalGenerate = await app.request("/v1/problems/prob_split/generate", {
      method: "POST",
      headers: internalHeaders(),
    });
    expect(internalGenerate.status).toBe(403);
    expect(await internalGenerate.json()).toEqual({ reason: "unqualified" });

    const projection = await app.request("/v1/projection", { headers: dashboardHeaders() });
    expect(projection.status).toBe(200);
  });

  it("does not honor query-token login from Host localhost", async () => {
    const { app } = await setup();
    const res = await app.request(`/?token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}`, {
      headers: { host: "localhost:8080" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Dashboard token");
    expect(html).not.toContain("Hourly projection");
  });

  it("honors query-token login only when explicitly enabled", async () => {
    harness = await createTestApp({ ...testConfig, allowQueryTokenLogin: true });
    const { app } = harness;
    const res = await app.request(`/?token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/HttpOnly/i);
  });

  it("rate-limits failed dashboard logins without echoing the token", async () => {
    const { app } = await setup();
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    for (let i = 0; i < 5; i += 1) {
      const failed = await app.request("/login", {
        method: "POST",
        headers,
        body: "token=wrong-guess-not-the-dashboard-token",
      });
      expect(failed.status).toBe(401);
      const text = await failed.text();
      expect(text).not.toContain("wrong-guess-not-the-dashboard-token");
    }
    const limited = await app.request("/login", {
      method: "POST",
      headers,
      body: `token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}`,
    });
    expect(limited.status).toBe(429);
    const limitedText = await limited.text();
    expect(limitedText).toContain("Too many attempts.");
    expect(limitedText).not.toContain(TEST_DASHBOARD_TOKEN);
    expect(limited.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
