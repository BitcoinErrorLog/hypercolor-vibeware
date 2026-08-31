# Hypercolor Vibeware

Evidence store, hourly projection, and owner dashboard for Hypercolor. This is **not** the Hypercolor chat app.

The service accepts coarse, allowlisted product events. It never stores message bodies, recovery codes, tokens, pubkies, or other user content. Agents may read `GET /v1/projection` only. They never read the `evidence` table.

Playbook §19 tables: `vibeware_surfaces`, `evidence`, `problems`, `candidates`, `experiments`, `evaluations`, `selections`, `state_transitions`.

## Run locally

Node 22. Tokens must be at least 16 characters and pairwise distinct. There are no built-in defaults. Boot throws if any two of ingest, dashboard, and internal are equal.

```bash
docker compose up -d
cp .env.example .env
# set three pairwise-distinct tokens: VIBEWARE_INGEST_TOKEN, VIBEWARE_DASHBOARD_TOKEN, and VIBEWARE_INTERNAL_TOKEN
npm install
npm run dev
```

`npm test` uses [PGlite](https://pglite.dev/) in-process (no Docker). If `VIBEWARE_TEST_DATABASE_URL` is set, or `DATABASE_URL` points at localhost, tests use that Postgres instead. Remote `DATABASE_URL` values are ignored so a Railway URL cannot be wiped by `npm test`.

```bash
npm test
npm run typecheck
npm run build
npm start
```

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes in production | Postgres connection string |
| `VIBEWARE_INGEST_TOKEN` | yes | Bearer token for `POST /v1/evidence`. Must differ from the other two tokens |
| `VIBEWARE_DASHBOARD_TOKEN` | yes | Read-only bearer/cookie token for projection, dashboard, and `/login`. Must differ from the other two tokens |
| `VIBEWARE_INTERNAL_TOKEN` | yes | Bearer token for detect, qualify, generate, experiments (create, assign, kill, evaluate), and `POST /internal/gc`. Must differ from the other two tokens |
| `VIBEWARE_ALLOW_QUERY_TOKEN_LOGIN` | no | Set `true` to honor `?token=` on `GET /`. Default off. Never inferred from `Host` |
| `VIBEWARE_INSECURE_COOKIE` | no | Set `true` for local http so the dashboard cookie is not `Secure`. Ignored when `NODE_ENV=production` or trusted `X-Forwarded-Proto=https` |
| `VIBEWARE_TRUST_PROXY` | no | Set `true` to trust `X-Forwarded-Proto` (cookie `Secure`) and `X-Forwarded-For` (login rate limit). Default off |
| `VIBEWARE_INGEST_ORIGINS` | no | Comma-separated exact origins (`scheme://host[:port]`) allowed to call `POST /v1/evidence` from a browser. Default `https://hypercolor-web.vercel.app`. Boot throws on `*`, empty entries, `null`, paths, query strings, credentials, or non-http(s) values |
| `PORT` | no | Listen port (default `8080`) |

## HTTP

- `POST /v1/evidence` — ingest. `Authorization: Bearer $VIBEWARE_INGEST_TOKEN`. Unknown event types return `200 {accepted:false,reason:"unknown_event"}`. Extra keys, banned keys, values outside the closed payload enums, pubky-shaped values, and recovery-code-shaped values are dropped, not persisted. Route and error fields are closed enums only; free-text values (including `/`, whitespace, `?`, `#`, `=`, `@`) are rejected. OPTIONS and POST always send `Vary: Origin`; `Access-Control-Allow-Origin` is set only for an exact allowlisted Origin.
- `GET /v1/projection` — last 14 days of hourly counts by `event_type` + coarse payload class, read from the `vibeware_evidence_projection` view. `Authorization: Bearer $VIBEWARE_DASHBOARD_TOKEN`. This is the only agent-readable evidence API. `model_allowed = false` rows never appear.
- `GET /` — HTML dashboard of those same counts, read from the `vibeware_evidence_projection` view. Authorize with `Authorization` or a login form that sets an httpOnly cookie. `?token=` works only when `VIBEWARE_ALLOW_QUERY_TOKEN_LOGIN=true`. HTML responses send `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `X-Content-Type-Options: nosniff`. Interpolated values are also `escapeHtml`'d.
- `POST /login` — sets the dashboard cookie. Failed attempts are rate-limited in memory (5 / 15 minutes per remote). The attempted token is not logged.
- `POST /v1/problems/detect` — `Authorization: Bearer $VIBEWARE_INTERNAL_TOKEN`. Runs rule-based detectors on `vibeware_evidence_projection` (never raw `evidence` rows), clusters hits into `problems`, writes `qualification` gates, and records `state_transitions`. Forbidden `suspected_scope` auto-rejects (`validation_failed`).
- `POST /v1/problems/:id/qualify` — internal token. Human only. Body `{qualified, actor, reason}`. Sets `qualified` or `rejected`. Cannot qualify a forbidden-scope rejection. `actor` is an audit label, not authentication: v1 has one shared internal token; per-human credentials are later. Human qualify is a full override of non-forbidden gates (playbook: human qualifies). The forbidden-boundary gate remains non-overridable.
- `POST /v1/problems/:id/generate` — internal token. `403 unqualified` unless `problems.state === qualified`. If qualified, persists a `candidates` row in `request_ready` with a `candidate_request` artifact (`surface`, evidence IDs only, path lists, budgets). No LLM. No PR. Generate still rechecks forbidden scope. Artifact `allowed_paths` always come from the surface manifest, not `suspected_scope`.
- `POST /v1/experiments` — internal token. Body `{candidate_id, candidate_sha, candidate_origin, percent?, actor?, reason?}`. Registers an immutable `candidate_build` (`sha` = 40 hex, `origin` = exact https origin; store only, never fetch). `403 candidate_not_ready` if the candidate is missing or not `request_ready`. Rejects `latest` / branch refs. Default `percent` is 10. Percent 11–25 requires human `{actor, reason}`. Percent above 25 is `403 percent_over_cap` in v1 even with a human. Per-surface `max_initial_percent` and `requires_human_for_percent_over` can only tighten those gates (a surface max of 5 rejects percent 10 without human). Effective cap is `min(request, surface.max, 25)`. Kill state is not taken from the request or from `candidate_build`.
- `GET /v1/experiments/:id` — dashboard or internal token. Experiment status (`state`, `killed`, `percent`, `candidate_build`). No assignment.
- `GET /v1/experiments/:id/assignment?cohort_key=` — internal token. Stable hash of `experiment_id + cohort_key` into 100 buckets; `candidate` if `unit < percent`, else `control`. After kill, every cohort is `control`. `cohort_key` is 64 hex and is not stored.
- `POST /v1/experiments/:id/kill` — internal token. Sets `experiments.killed` and `state=killed` on this control plane. One request returns all later assignments to control. The kill switch is not a candidate field and cannot be overridden by `candidate_build`.
- `POST /v1/experiments/:id/evaluate` — internal token. Separate evaluator. Reads `vibeware_evidence_projection` only (never raw `evidence`). `403 minimum_exposure_hours` until `started_at + surface.minimum_exposure_hours` (default 48). Writes `evaluations.result.decision_input` with counts and rates. Primary metric comes from the surface manifest (`empty_state_escape_rate`, `send_settle_success`, `onboarding_completion_rate`), not from a candidate. Guardrails: `app.error.coarse` rate and whether `send_settled=failed` increased vs the prior window. No LLM. Rejects banned keys and banned values (pubky-shaped, recovery-shaped, credential URLs).
- `qualification_score` on persisted `problems.qualification` is advisory only.
- Dashboard `GET /` also lists problems (`id`, surface, state, title). No raw evidence.
- `POST /internal/gc` — `Authorization: Bearer $VIBEWARE_INTERNAL_TOKEN`. Deletes evidence past 14-day retention. The process also runs this on a 15-minute timer.
- `GET /health` — liveness.

## Local Docker credentials (waived)

`docker-compose.yml` and `.env.example` use Postgres user/password `vibeware:vibeware` for the local compose database only. That password is local-only and must never be reused on a reachable host. Tests (`npm test`) use PGlite or that local URL; do not generate random compose passwords in a way that breaks `npm test`.

## Railway

This repo is a web service plus a Postgres plugin. Parent links the project (`railway link`) and sets the three tokens. The plugin injects `DATABASE_URL`. See `railway.toml`. Set `VIBEWARE_TRUST_PROXY=true` behind Railway so `Secure` cookies follow `X-Forwarded-Proto`.

Do not put tokens in this repository.

## Privacy gate

Persisted rows are allowlisted coarse events only, with `model_allowed=true`. Every payload field is a closed enum (`PAYLOAD_ENUMS` is exhaustive for `PAYLOAD_FIELDS`). Raw evidence expires after 14 days and is deleted. The SQL view `vibeware_evidence_projection` is the only dashboard, detect, agent, and evaluate read path (`GET /`, `POST /v1/problems/detect`, `GET /v1/projection`, and `POST /v1/experiments/:id/evaluate`). Raw `evidence` rows are never selected on those paths.
