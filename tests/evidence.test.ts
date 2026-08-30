import { afterEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/body.js";
import { gcExpiredEvidence } from "../src/gc.js";
import { readProjection, serializeProjection } from "../src/projection.js";
import {
  allowlistedEvent,
  closeTestApp,
  createTestApp,
  dashboardHeaders,
  ingestHeaders,
  internalHeaders,
  socketEnv,
  TEST_COHORT_KEY,
  TEST_DASHBOARD_TOKEN,
  TEST_INGEST_ORIGIN,
  testConfig,
} from "./harness.js";

const UNKNOWN_ORIGIN = "https://evil.example";

function expectNoCors(res: Response) {
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("access-control-allow-credentials")).toBeNull();
}

function expectIngestCors(res: Response, origin: string) {
  expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  expect(res.headers.get("vary")).toBe("Origin");
  expect(res.headers.get("access-control-allow-credentials")).toBeNull();
}

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
    const env = socketEnv("198.51.100.10");
    for (let i = 0; i < 5; i += 1) {
      const failed = await app.request(
        "/login",
        {
          method: "POST",
          headers,
          body: "token=wrong-guess-not-the-dashboard-token",
        },
        env,
      );
      expect(failed.status).toBe(401);
      const text = await failed.text();
      expect(text).not.toContain("wrong-guess-not-the-dashboard-token");
    }
    const limited = await app.request(
      "/login",
      {
        method: "POST",
        headers,
        body: `token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}`,
      },
      env,
    );
    expect(limited.status).toBe(429);
    const limitedText = await limited.text();
    expect(limitedText).toContain("Too many attempts.");
    expect(limitedText).not.toContain(TEST_DASHBOARD_TOKEN);
    expect(limited.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not share a login bucket across distinct remotes", async () => {
    const { app } = await setup();
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    const attacker = socketEnv("198.51.100.20");
    const other = socketEnv("198.51.100.21");
    for (let i = 0; i < 5; i += 1) {
      const failed = await app.request(
        "/login",
        { method: "POST", headers, body: "token=wrong-guess-not-the-dashboard-token" },
        attacker,
      );
      expect(failed.status).toBe(401);
    }
    const locked = await app.request(
      "/login",
      { method: "POST", headers, body: `token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}` },
      attacker,
    );
    expect(locked.status).toBe(429);

    const otherFailed = await app.request(
      "/login",
      { method: "POST", headers, body: "token=wrong-guess-not-the-dashboard-token" },
      other,
    );
    expect(otherFailed.status).toBe(401);

    const otherOk = await app.request(
      "/login",
      { method: "POST", headers, body: `token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}` },
      other,
    );
    expect(otherOk.status).toBe(302);
  });

  it("keys trusted-proxy logins on the rightmost X-Forwarded-For hop", async () => {
    harness = await createTestApp({ ...testConfig, trustProxy: true });
    const { app } = harness;
    const form = { "content-type": "application/x-www-form-urlencoded" };
    for (let i = 0; i < 5; i += 1) {
      const failed = await app.request("/login", {
        method: "POST",
        headers: { ...form, "x-forwarded-for": "203.0.113.1, 192.0.2.10" },
        body: "token=wrong-guess-not-the-dashboard-token",
      });
      expect(failed.status).toBe(401);
    }
    const rotatedClient = await app.request("/login", {
      method: "POST",
      headers: { ...form, "x-forwarded-for": "198.51.100.1, 192.0.2.10" },
      body: `token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}`,
    });
    expect(rotatedClient.status).toBe(429);

    const otherEdge = await app.request("/login", {
      method: "POST",
      headers: { ...form, "x-forwarded-for": "203.0.113.1, 192.0.2.99" },
      body: "token=wrong-guess-not-the-dashboard-token",
    });
    expect(otherEdge.status).toBe(401);
  });

  it("returns duplicate instead of 500 for a repeated event_id", async () => {
    const { app, db } = await setup();
    const event = allowlistedEvent({ event_id: "evt_dup_1" });
    const first = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(event),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: true, id: "evt_dup_1" });

    const second = await app.request("/v1/evidence", {
      method: "POST",
      headers: ingestHeaders(),
      body: JSON.stringify(event),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ accepted: false, reason: "duplicate" });
    expect(await dumpEvidence(db)).toHaveLength(1);
  });

  it("rejects oversized Content-Length without hanging on the body", async () => {
    const { app } = await setup();
    const headers = ingestHeaders();
    headers.set("content-length", "9000");
    const hang = new ReadableStream<Uint8Array>({
      pull() {
        // never enqueue — hang if the handler reads the body
      },
    });
    const res = await Promise.race([
      app.request("/v1/evidence", {
        method: "POST",
        headers,
        body: hang,
        duplex: "half",
      } as RequestInit),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("oversized ingest hung reading the body")), 1000);
      }),
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: "payload_too_large" });
  });

  it("rejects oversized login bodies without reading past the ingest cap", async () => {
    const { app } = await setup();
    const hang = new ReadableStream<Uint8Array>({
      pull() {
        // never enqueue — hang if the handler reads the body
      },
    });
    const declared = await Promise.race([
      app.request("/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(MAX_BODY_BYTES + 1),
        },
        body: hang,
        duplex: "half",
      } as RequestInit),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("oversized login hung reading the body")), 1000);
      }),
    ]);
    expect(declared.status).toBe(413);
    expect(declared.headers.get("set-cookie")).toBeNull();
    const declaredHtml = await declared.text();
    expect(declaredHtml).toContain("Payload too large.");
    expect(declaredHtml).not.toContain(TEST_DASHBOARD_TOKEN);

    const streamed = await Promise.race([
      app.request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1));
          },
          pull() {
            // further reads would hang
          },
        }),
        duplex: "half",
      } as RequestInit),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("streamed login hung past the cap")), 1000);
      }),
    ]);
    expect(streamed.status).toBe(413);
    expect(streamed.headers.get("set-cookie")).toBeNull();
    expect(await streamed.text()).toContain("Payload too large.");
  });

  it("allowlisted Origin preflight returns 204 with CORS headers and no credentials", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "OPTIONS",
      headers: {
        origin: TEST_INGEST_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expectIngestCors(res, TEST_INGEST_ORIGIN);
  });

  it("unknown Origin preflight returns success without ACAO", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/evidence", {
      method: "OPTIONS",
      headers: {
        origin: UNKNOWN_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect([200, 204]).toContain(res.status);
    expectNoCors(res);
    expect(res.headers.get("vary") ?? "").toMatch(/Origin/);
  });

  it("allowlisted Origin POST with a valid bearer returns 200 and ACAO", async () => {
    const { app } = await setup();
    const headers = ingestHeaders();
    headers.set("origin", TEST_INGEST_ORIGIN);
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers,
      body: JSON.stringify(allowlistedEvent({ event_id: "evt_cors_ok" })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, id: "evt_cors_ok" });
    expectIngestCors(res, TEST_INGEST_ORIGIN);
  });

  it("unknown Origin POST with a valid bearer is authorized without ACAO", async () => {
    const { app } = await setup();
    const headers = ingestHeaders();
    headers.set("origin", UNKNOWN_ORIGIN);
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers,
      body: JSON.stringify(allowlistedEvent({ event_id: "evt_cors_unknown" })),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, id: "evt_cors_unknown" });
    expectNoCors(res);
    expect(res.headers.get("vary") ?? "").toMatch(/Origin/);
  });

  it("does not send ACAO on non-ingest routes for an ingest Origin", async () => {
    const { app, db } = await setup();
    await db.query(
      `INSERT INTO problems (id, surface_id, title, summary, state)
       VALUES ('prob_cors', 'hc-chats-ui', 'empty dms', 'empty state persists', 'detected')`,
    );

    const dashboardHeadersWithOrigin = dashboardHeaders();
    dashboardHeadersWithOrigin.set("origin", TEST_INGEST_ORIGIN);
    const dashboard = await app.request("/", { headers: dashboardHeadersWithOrigin });
    expect(dashboard.status).toBe(200);
    expectNoCors(dashboard);

    const projectionHeadersWithOrigin = dashboardHeaders();
    projectionHeadersWithOrigin.set("origin", TEST_INGEST_ORIGIN);
    const projection = await app.request("/v1/projection", { headers: projectionHeadersWithOrigin });
    expect(projection.status).toBe(200);
    expectNoCors(projection);

    const login = await app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_INGEST_ORIGIN,
        host: "localhost:8080",
      },
      body: `token=${encodeURIComponent(TEST_DASHBOARD_TOKEN)}`,
    });
    expect([200, 302, 401, 403]).toContain(login.status);
    expectNoCors(login);

    const detectHeaders = internalHeaders();
    detectHeaders.set("origin", TEST_INGEST_ORIGIN);
    const detect = await app.request("/v1/problems/detect", { method: "POST", headers: detectHeaders });
    expect([200, 401, 403]).toContain(detect.status);
    expectNoCors(detect);

    const qualifyHeaders = internalHeaders();
    qualifyHeaders.set("origin", TEST_INGEST_ORIGIN);
    qualifyHeaders.set("content-type", "application/json");
    const qualify = await app.request("/v1/problems/prob_cors/qualify", {
      method: "POST",
      headers: qualifyHeaders,
      body: JSON.stringify({ qualified: true, actor: "cors-test", reason: "audit" }),
    });
    expect([200, 401, 403]).toContain(qualify.status);
    expectNoCors(qualify);

    const generateHeaders = internalHeaders();
    generateHeaders.set("origin", TEST_INGEST_ORIGIN);
    const generate = await app.request("/v1/problems/prob_cors/generate", {
      method: "POST",
      headers: generateHeaders,
    });
    expect([200, 201, 401, 403]).toContain(generate.status);
    expectNoCors(generate);

    const gcHeaders = internalHeaders();
    gcHeaders.set("origin", TEST_INGEST_ORIGIN);
    const gc = await app.request("/internal/gc", { method: "POST", headers: gcHeaders });
    expect([200, 401, 403]).toContain(gc.status);
    expectNoCors(gc);
  });
});
