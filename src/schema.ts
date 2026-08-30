export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS vibeware_surfaces (
  id text primary key,
  manifest jsonb not null,
  owner text not null,
  created_at timestamptz not null default now()
)`,
  `CREATE TABLE IF NOT EXISTS evidence (
  id text primary key,
  surface_id text not null,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  model_allowed boolean not null,
  expires_at timestamptz
)`,
  `CREATE TABLE IF NOT EXISTS problems (
  id text primary key,
  surface_id text not null,
  title text not null,
  summary text not null,
  qualification jsonb,
  state text not null,
  created_at timestamptz not null default now()
)`,
  `CREATE TABLE IF NOT EXISTS candidates (
  id text primary key,
  problem_id text not null,
  state text not null,
  base_sha text not null,
  branch text,
  artifact jsonb,
  created_at timestamptz not null default now()
)`,
  `CREATE TABLE IF NOT EXISTS experiments (
  id text primary key,
  candidate_id text not null,
  config jsonb not null,
  state text not null,
  started_at timestamptz,
  ended_at timestamptz
)`,
  `CREATE TABLE IF NOT EXISTS evaluations (
  id text primary key,
  experiment_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
)`,
  `CREATE TABLE IF NOT EXISTS selections (
  id text primary key,
  candidate_id text not null,
  decision text not null,
  actor text not null,
  reason text,
  created_at timestamptz not null default now()
)`,
  `CREATE TABLE IF NOT EXISTS state_transitions (
  id bigserial primary key,
  object_type text not null,
  object_id text not null,
  from_state text,
  to_state text not null,
  actor text not null,
  reason text,
  metadata jsonb,
  created_at timestamptz not null default now()
)`,
  `CREATE INDEX IF NOT EXISTS evidence_occurred_at_idx ON evidence (occurred_at)`,
  `CREATE INDEX IF NOT EXISTS evidence_expires_at_idx ON evidence (expires_at)`,
  `CREATE INDEX IF NOT EXISTS evidence_model_allowed_idx ON evidence (model_allowed, occurred_at)`,
  `CREATE OR REPLACE VIEW vibeware_evidence_projection AS
SELECT
  date_trunc('hour', occurred_at) AS hour,
  type AS event_type,
  CASE type
    WHEN 'app.route.viewed' THEN concat_ws('|', payload->>'route', payload->>'from_route')
    WHEN 'app.onboarding.state' THEN coalesce(payload->>'state', '')
    WHEN 'app.onboarding.abandoned' THEN coalesce(payload->>'step', '')
    WHEN 'app.chat.empty_state' THEN coalesce(payload->>'kind', '')
    WHEN 'app.thread.send_settled' THEN concat_ws('|', payload->>'channel', payload->>'outcome', payload->>'kind')
    WHEN 'app.request.decision' THEN concat_ws('|', payload->>'kind', payload->>'decision')
    WHEN 'app.backup.export_outcome' THEN coalesce(payload->>'outcome', '')
    WHEN 'app.error.coarse' THEN concat_ws('|', payload->>'code', payload->>'surface')
    WHEN 'app.pwa.installed' THEN coalesce(payload->>'outcome', '')
    ELSE NULL
  END AS payload_class,
  count(*)::bigint AS event_count
FROM evidence
WHERE model_allowed = true
  AND occurred_at > (now() - interval '14 days')
  AND (expires_at IS NULL OR expires_at > now())
GROUP BY 1, 2, 3`,
];

export const TEST_RESET_STATEMENTS: readonly string[] = [
  "DROP VIEW IF EXISTS vibeware_evidence_projection",
  "DROP TABLE IF EXISTS state_transitions CASCADE",
  "DROP TABLE IF EXISTS selections CASCADE",
  "DROP TABLE IF EXISTS evaluations CASCADE",
  "DROP TABLE IF EXISTS experiments CASCADE",
  "DROP TABLE IF EXISTS candidates CASCADE",
  "DROP TABLE IF EXISTS problems CASCADE",
  "DROP TABLE IF EXISTS evidence CASCADE",
  "DROP TABLE IF EXISTS vibeware_surfaces CASCADE",
];
