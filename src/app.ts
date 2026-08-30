import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { MAX_BODY_BYTES, readTextLimited } from "./body.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { renderDashboardPage, renderLoginPage } from "./dashboard.js";
import type { DetectorHit } from "./detectors.js";
import { gcExpiredEvidence } from "./gc.js";
import { detectProblems, generateCandidate, listProblems, publicProblem, qualifyProblem } from "./problems.js";
import { evaluateEvidence } from "./privacy.js";
import { readProjection, serializeProjection } from "./projection.js";
import { createFailureLimiter } from "./rateLimit.js";
import { bearerMatches, tokensEqual } from "./tokens.js";

export type AppOptions = {
  now?: () => Date;
  extraDetectors?: () => DetectorHit[];
};

const DASHBOARD_COOKIE = "vw_dashboard";
const LOGIN_FAILURE_MAX = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'";

function forwardedProto(c: Context, config: Config): string | undefined {
  if (!config.trustProxy) return undefined;
  const raw = c.req.header("x-forwarded-proto");
  if (!raw) return undefined;
  return raw.split(",")[0]?.trim().toLowerCase();
}

function cookieSecure(c: Context, config: Config): boolean {
  if (config.nodeEnv === "production") return true;
  if (forwardedProto(c, config) === "https") return true;
  if (config.insecureCookie) return false;
  return true;
}

function rightmostForwardedFor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hops = raw.split(",");
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i]?.trim();
    if (hop) return hop;
  }
  return undefined;
}

function socketRemoteAddress(c: Context): string | undefined {
  try {
    const address = getConnInfo(c).remote.address;
    if (typeof address === "string" && address.length > 0) return address;
  } catch {
    // app.request() without node bindings has no socket
  }
  return undefined;
}

function loginClientKey(c: Context, config: Config): string {
  if (config.trustProxy) {
    const forwarded = rightmostForwardedFor(c.req.header("x-forwarded-for"));
    if (forwarded) return forwarded;
  }
  const remote = socketRemoteAddress(c);
  if (remote) return remote;
  return `unattributed:${randomUUID()}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
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

function attachDashboardCookie(c: Context, config: Config): void {
  setCookie(c, DASHBOARD_COOKIE, config.dashboardToken, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: cookieSecure(c, config),
    maxAge: 60 * 60 * 12,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseQualifyBody(value: unknown): { qualified: boolean; actor: string; reason: string } | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.qualified !== "boolean") return null;
  if (typeof value.actor !== "string" || value.actor.trim().length === 0) return null;
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) return null;
  return { qualified: value.qualified, actor: value.actor.trim(), reason: value.reason.trim() };
}

export function createApp(db: Database, config: Config, options: AppOptions = {}) {
  const app = new Hono();
  const clock = options.now ?? (() => new Date());
  const loginFailures = createFailureLimiter({
    max: LOGIN_FAILURE_MAX,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
  });

  app.use("*", async (c, next) => {
    await next();
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      c.res.headers.set("Content-Security-Policy", HTML_CSP);
      c.res.headers.set("X-Content-Type-Options", "nosniff");
    }
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/v1/evidence", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.ingestToken)) {
      return c.json({ accepted: false, reason: "unauthorized" }, 401);
    }
    const limited = await readTextLimited(c.req.raw, MAX_BODY_BYTES);
    if (!limited.ok) {
      return c.json({ accepted: false, reason: "payload_too_large" }, 200);
    }
    let body: unknown;
    try {
      body = JSON.parse(limited.text) as unknown;
    } catch {
      return c.json({ accepted: false, reason: "invalid_json" }, 400);
    }
    const decision = evaluateEvidence(body, () => `evt_${randomUUID()}`, () => clock().getTime());
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
    try {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO evidence (id, surface_id, type, payload, occurred_at, model_allowed, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, true, $5::timestamptz + interval '14 days')
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          decision.row.id,
          decision.row.surfaceId,
          decision.row.type,
          JSON.stringify(decision.row.payload),
          decision.row.occurredAt.toISOString(),
        ],
      );
      if (inserted.length === 0) {
        return c.json({ accepted: false, reason: "duplicate" }, 200);
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ accepted: false, reason: "duplicate" }, 200);
      }
      throw error;
    }
    return c.json({ accepted: true, id: decision.row.id }, 200);
  });

  app.get("/v1/projection", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.dashboardToken)) {
      return c.json({ accepted: false, reason: "unauthorized" }, 401);
    }
    const rows = serializeProjection(await readProjection(db, clock()));
    return c.json({ window_days: 14, rows });
  });

  app.post("/v1/problems/detect", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.internalToken)) {
      return c.json({ reason: "unauthorized" }, 401);
    }
    const extra = options.extraDetectors?.() ?? [];
    const problems = await detectProblems(db, clock(), extra);
    return c.json({ problems: problems.map(publicProblem) }, 200);
  });

  app.post("/v1/problems/:id/qualify", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.internalToken)) {
      return c.json({ reason: "unauthorized" }, 401);
    }
    const limited = await readTextLimited(c.req.raw, MAX_BODY_BYTES);
    if (!limited.ok) {
      return c.json({ reason: "payload_too_large" }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(limited.text) as unknown;
    } catch {
      return c.json({ reason: "invalid_json" }, 400);
    }
    const parsed = parseQualifyBody(body);
    if (!parsed) {
      return c.json({ reason: "invalid_body" }, 400);
    }
    const result = await qualifyProblem(db, {
      id: c.req.param("id"),
      qualified: parsed.qualified,
      actor: parsed.actor,
      reason: parsed.reason,
      now: clock(),
    });
    if (!result.ok) {
      return c.json({ reason: result.reason }, result.status);
    }
    return c.json(publicProblem(result.problem), 200);
  });

  app.post("/v1/problems/:id/generate", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.internalToken)) {
      return c.json({ reason: "unauthorized" }, 401);
    }
    const result = await generateCandidate(db, c.req.param("id"));
    if (!result.ok) {
      return c.json({ reason: result.reason }, result.status);
    }
    return c.json(result.candidate, result.created ? 201 : 200);
  });

  app.post("/internal/gc", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), config.internalToken)) {
      return c.json({ reason: "unauthorized" }, 401);
    }
    const deleted = await gcExpiredEvidence(db);
    return c.json({ deleted });
  });

  app.post("/login", async (c) => {
    const key = loginClientKey(c, config);
    if (loginFailures.isLimited(key)) {
      return c.html(renderLoginPage("Too many attempts."), 429);
    }
    const limited = await readTextLimited(c.req.raw, MAX_BODY_BYTES);
    if (!limited.ok) {
      return c.html(renderLoginPage("Payload too large."), 413);
    }
    const token = new URLSearchParams(limited.text).get("token") ?? "";
    if (!tokensEqual(token, config.dashboardToken)) {
      loginFailures.recordFailure(key);
      return c.html(renderLoginPage("Invalid token."), 401);
    }
    loginFailures.clear(key);
    attachDashboardCookie(c, config);
    return c.redirect("/", 302);
  });

  app.get("/", async (c) => {
    const queryToken = c.req.query("token");
    if (queryToken !== undefined) {
      if (!config.allowQueryTokenLogin) {
        return c.html(renderLoginPage(), 200);
      }
      if (!tokensEqual(queryToken, config.dashboardToken)) {
        return c.html(renderLoginPage("Invalid token."), 401);
      }
      attachDashboardCookie(c, config);
      return c.redirect("/", 302);
    }
    if (!dashboardAuthorized(c.req.header("authorization"), getCookie(c, DASHBOARD_COOKIE), config.dashboardToken)) {
      return c.html(renderLoginPage(), 200);
    }
    const now = clock();
    const rows = await readProjection(db, now);
    const problems = await listProblems(db);
    return c.html(renderDashboardPage(rows, problems), 200);
  });

  return app;
}
