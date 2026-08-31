import type { Database } from "./db.js";
import { PROJECTION_PAYLOAD_CLASS_SQL } from "./schema.js";

export type ProjectionRow = {
  hour: Date | string;
  event_type: string;
  payload_class: string | null;
  event_count: string | number | bigint;
};

export async function readProjectionView(db: Database): Promise<ProjectionRow[]> {
  return db.query<ProjectionRow>(
    `SELECT hour, event_type, payload_class, event_count
     FROM vibeware_evidence_projection
     ORDER BY hour DESC, event_type, payload_class`,
  );
}

export async function readProjection(db: Database, now?: Date): Promise<ProjectionRow[]> {
  if (!now) return readProjectionView(db);
  return db.query<ProjectionRow>(
    `SELECT
        date_trunc('hour', occurred_at) AS hour,
        type AS event_type,
        ${PROJECTION_PAYLOAD_CLASS_SQL} AS payload_class,
        count(*)::bigint AS event_count
     FROM evidence
     WHERE model_allowed = true
       AND occurred_at > ($1::timestamptz - interval '14 days')
       AND (expires_at IS NULL OR expires_at > $1::timestamptz)
     GROUP BY 1, 2, 3
     ORDER BY hour DESC, event_type, payload_class`,
    [now.toISOString()],
  );
}

export type SerializedProjectionRow = {
  hour: string;
  event_type: string;
  payload_class: string | null;
  event_count: number;
};

export function serializeProjection(rows: ProjectionRow[]): SerializedProjectionRow[] {
  return rows.map((row) => ({
    hour: row.hour instanceof Date ? row.hour.toISOString() : String(row.hour),
    event_type: row.event_type,
    payload_class: row.payload_class,
    event_count: Number(row.event_count),
  }));
}
