import type { Database } from "./db.js";

export async function gcExpiredEvidence(db: Database): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM evidence
     WHERE expires_at <= now()
        OR occurred_at <= (now() - interval '14 days')
     RETURNING id`,
  );
  return rows.length;
}

export function startGcSchedule(
  db: Database,
  intervalMs = 15 * 60 * 1000,
  onError: (error: unknown) => void = (error) => {
    console.error("vibeware gc failed", error);
  },
): () => void {
  const run = () => {
    void gcExpiredEvidence(db).catch(onError);
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
