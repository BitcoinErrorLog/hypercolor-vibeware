import type { Database } from "./db.js";

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
