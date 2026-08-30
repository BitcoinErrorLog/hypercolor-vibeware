import { EVENT_TYPES } from "./privacy.js";
import { serializeProjection, type ProjectionRow } from "./projection.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderLoginPage(error?: string): string {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vibeware dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#111; --fg:#f4f1ea; --muted:#9a958c; --accent:#e8a87c; --err:#e07a7a; }
    body { margin:0; font:16px/1.5 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
    main { max-width:28rem; margin:12vh auto; padding:0 1.25rem; }
    h1 { font-size:1.25rem; font-weight:600; }
    p { color:var(--muted); }
    label { display:block; margin:1rem 0 0.35rem; }
    input { width:100%; box-sizing:border-box; padding:0.6rem 0.7rem; border:1px solid #333; border-radius:6px; background:#1b1b1b; color:var(--fg); }
    button { margin-top:1rem; padding:0.55rem 0.9rem; border:0; border-radius:6px; background:var(--accent); color:#111; font-weight:600; cursor:pointer; }
    .error { color:var(--err); }
  </style>
</head>
<body>
  <main>
    <h1>Vibeware evidence dashboard</h1>
    <p>This is not the Hypercolor app. Counts only. No raw evidence.</p>
    ${message}
    <form method="post" action="/login">
      <label for="token">Dashboard token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" required />
      <button type="submit">Open dashboard</button>
    </form>
  </main>
</body>
</html>`;
}

export function renderDashboardPage(rows: ProjectionRow[]): string {
  const serialized = serializeProjection(rows);
  const totals = new Map<string, number>(EVENT_TYPES.map((type) => [type, 0]));
  for (const row of serialized) {
    totals.set(row.event_type, (totals.get(row.event_type) ?? 0) + row.event_count);
  }
  const totalRows = EVENT_TYPES.map(
    (type) =>
      `<tr><td>${escapeHtml(type)}</td><td>${escapeHtml(String(totals.get(type) ?? 0))}</td></tr>`,
  ).join("");
  const hourlyRows =
    serialized.length === 0
      ? `<tr><td colspan="4">No events in the last 14 days.</td></tr>`
      : serialized
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.hour)}</td><td>${escapeHtml(row.event_type)}</td><td>${escapeHtml(row.payload_class ?? "")}</td><td>${escapeHtml(String(row.event_count))}</td></tr>`,
          )
          .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vibeware dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#111; --fg:#f4f1ea; --muted:#9a958c; --accent:#e8a87c; --line:#2a2a2a; }
    body { margin:0; font:15px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
    main { max-width:56rem; margin:0 auto; padding:2rem 1.25rem 4rem; }
    h1, h2 { font-weight:600; }
    h1 { font-size:1.35rem; }
    h2 { font-size:1.05rem; margin-top:2rem; }
    p { color:var(--muted); }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; padding:0.45rem 0.5rem; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--accent); font-size:0.8rem; text-transform:uppercase; letter-spacing:0.04em; }
    code { color:var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>Vibeware evidence dashboard</h1>
    <p>Last 14 days. Hourly counts by event type and coarse payload class. This is not the Hypercolor app. No user content. No agent. No raw <code>evidence</code> rows.</p>
    <h2>Nine-event totals</h2>
    <table>
      <thead><tr><th>Event</th><th>Count</th></tr></thead>
      <tbody>${totalRows}</tbody>
    </table>
    <h2>Hourly projection</h2>
    <table>
      <thead><tr><th>Hour</th><th>Event</th><th>Payload class</th><th>Count</th></tr></thead>
      <tbody>${hourlyRows}</tbody>
    </table>
  </main>
</body>
</html>`;
}
