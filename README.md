# Hypercolor Vibeware

Evidence store, hourly projection, and owner dashboard for Hypercolor. This is **not** the Hypercolor chat app.

The service accepts coarse, allowlisted product events. It never stores message bodies, recovery codes, tokens, pubkies, or other user content. Agents may read `GET /v1/projection` only. They never read the `evidence` table.

Playbook §19 tables: `vibeware_surfaces`, `evidence`, `problems`, `candidates`, `experiments`, `evaluations`, `selections`, `state_transitions`.

## Run locally

Node 22. Tokens must be at least 16 characters. There are no built-in defaults.

```bash
docker compose up -d
cp .env.example .env
# set VIBEWARE_INGEST_TOKEN and VIBEWARE_DASHBOARD_TOKEN
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
| `VIBEWARE_INGEST_TOKEN` | yes | Bearer token for `POST /v1/evidence` |
| `VIBEWARE_DASHBOARD_TOKEN` | yes | Bearer token for projection, dashboard, generate guard, and GC |
| `PORT` | no | Listen port (default `8080`) |

## HTTP

- `POST /v1/evidence` — ingest. `Authorization: Bearer $VIBEWARE_INGEST_TOKEN`. Unknown event types return `200 {accepted:false,reason:"unknown_event"}`. Extra keys, banned keys, pubky-shaped values, and recovery-code-shaped values are dropped, not persisted.
- `GET /v1/projection` — last 14 days of hourly counts by `event_type` + coarse payload class. `Authorization: Bearer $VIBEWARE_DASHBOARD_TOKEN`. This is the only agent-readable evidence API. `model_allowed = false` rows never appear.
- `GET /` — HTML dashboard of those same counts. Authorize with `Authorization`, a login form that sets an httpOnly cookie, or `?token=` **only on localhost**.
- `POST /v1/problems/:id/generate` — `403` unless `problems.state === qualified`. Qualified problems still get `403 generation_disabled` until Phase 2/3 wires a real generator.
- `POST /internal/gc` — deletes evidence past 14-day retention. The process also runs this on a 15-minute timer.
- `GET /health` — liveness.

## Railway

This repo is a web service plus a Postgres plugin. Parent links the project (`railway link`) and sets the two tokens. The plugin injects `DATABASE_URL`. See `railway.toml`.

Do not put tokens in this repository.

## Privacy gate

Persisted rows are allowlisted coarse events only, with `model_allowed=true`. Raw evidence expires after 14 days and is deleted. The SQL view `vibeware_evidence_projection` is the only read path used by the dashboard and the projection API.
