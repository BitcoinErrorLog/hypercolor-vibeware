import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { renderDashboardPage, renderLoginPage } from "./dashboard.js";
import { gcExpiredEvidence } from "./gc.js";
import { evaluateEvidence } from "./privacy.js";
import { readProjection, serializeProjection } from "./projection.js";
import { bearerMatches, tokensEqual } from "./tokens.js";

const MAX_BODY_BYTES = 8192;
const DASHBOARD_COOKIE = "vw_dashboard";

function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  return host.split(":")[0] ?? "";
}

function isLocalhostHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function dashboardAuthorized(
  header: string | undefined,
  cookieToken: string | undefined,
  expected: string,
): boolean {
  if (bearerMatches(header, expected)) return true;
  if (cookieToken && tokensEqual(cookieToken, expected)) return true;
  return false;
}

function attachDashboardCookie(c: Context, token: string): void {
  const local = isLocalhostHost(c.req.header("host"));
  setCookie(c, DASHBOARD_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: !local,
    maxAge: 60 * 60 * 12,
  });
}

export function createApp(db: Database, config: Config) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/v1/evidence", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.ingestToken)) {
      return c.json({ accepted: false, reason: "unauthorized" }, 401);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return c.json({ accepted: false, reason: "payload_too_large" }, 200);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return c.json({ accepted: false, reason: "invalid_json" }, 400);
    }
    const decision = evaluateEvidence(body, () => `evt_${randomUUID()}`);
    if (!decision.accepted) {
      return c.json({ accepted: false, reason: decision.reason }, 200);
    }
    const surfaces = await db.query<{ id: string }>(
      `SELECT id FROM vibeware_surfaces WHERE id = $1`,
      [decision.row.surfaceId],
    );
    if (surfaces.length === 0) {
      return c.json({ accepted: false, reason: "unknown_surface" }, 200);
    }
    await db.query(
      `INSERT INTO evidence (id, surface_id, type, payload, occurred_at, model_allowed, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, true, $5::timestamptz + interval '14 days')`,
      [
        decision.row.id,
        decision.row.surfaceId,
        decision.row.type,
        JSON.stringify(decision.row.payload),
        decision.row.occurredAt.toISOString(),
      ],
    );
    return c.json({ accepted: true, id: decision.row.id }, 200);
  });

  app.get("/v1/projection", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.dashboardToken)) {
      return c.json({ accepted: false, reason: "unauthorized" }, 401);
    }
    const rows = serializeProjection(await readProjection(db));
    return c.json({ window_days: 14, rows });
  });

  app.post("/v1/problems/:id/generate", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.dashboardToken)) {
      return c.json({ reason: "unauthorized" }, 401);
    }
    const id = c.req.param("id");
    const problems = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM problems WHERE id = $1`,
      [id],
    );
    const problem = problems[0];
    if (!problem) {
      return c.json({ reason: "not_found" }, 404);
    }
    if (problem.state !== "qualified") {
      return c.json({ reason: "unqualified" }, 403);
    }
    return c.json({ reason: "generation_disabled" }, 403);
  });

  app.post("/internal/gc", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.dashboardToken)) {
      return c.json({ reason: "unauthorized" }, 401);
    }
    const deleted = await gcExpiredEvidence(db);
    return c.json({ deleted });
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const token = typeof form.token === "string" ? form.token : "";
    if (!tokensEqual(token, config.dashboardToken)) {
      return c.html(renderLoginPage("Invalid token."), 401);
    }
    attachDashboardCookie(c, config.dashboardToken);
    return c.redirect("/", 302);
  });

  app.get("/", async (c) => {
    const host = c.req.header("host");
    const queryToken = c.req.query("token");
    if (queryToken !== undefined) {
      if (!isLocalhostHost(host)) {
        return c.html(renderLoginPage(), 200);
      }
      if (!tokensEqual(queryToken, config.dashboardToken)) {
        return c.html(renderLoginPage("Invalid token."), 401);
      }
      attachDashboardCookie(c, config.dashboardToken);
      return c.redirect("/", 302);
    }
    if (!dashboardAuthorized(c.req.header("authorization"), getCookie(c, DASHBOARD_COOKIE), config.dashboardToken)) {
      return c.html(renderLoginPage(), 200);
    }
    const rows = await readProjection(db);
    return c.html(renderDashboardPage(rows), 200);
  });

  return app;
}
