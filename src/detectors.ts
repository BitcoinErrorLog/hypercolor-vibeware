import type { SerializedProjectionRow } from "./projection.js";
import { buildQualification, evaluateGates, type Qualification } from "./qualify.js";
import { surfaceById, type SurfaceRecord } from "./surfaces.js";

export const MIN_SAMPLE = 12;
export const MIN_RATE_BUCKETS = 6;
export const RATE_RATIO = 1.25;
export const DECLINE_RATIO = 3;
export const EMPTY_ESCAPE_MAX_RATIO = 0.05;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type DetectorHit = {
  detectorKey: string;
  surfaceId: string;
  title: string;
  summary: string;
  suspectedScope: string[];
  evidenceTypes: string[];
  window: { start: string; end: string };
  sampleSize: number;
  bucketCount: number;
  metrics: Record<string, number>;
  roadmapRelevant: boolean;
};

export type PreparedProblem = DetectorHit & {
  qualification: Qualification;
};

export function hourIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()),
  ).toISOString();
}

function hourMs(value: Date | string): number {
  return new Date(hourIso(value)).getTime();
}

function countOf(rows: readonly SerializedProjectionRow[]): number {
  return rows.reduce((sum, row) => sum + row.event_count, 0);
}

function bucketsOf(rows: readonly SerializedProjectionRow[]): string[] {
  return [...new Set(rows.map((row) => hourIso(row.hour)))].sort();
}

function inHours(
  rows: readonly SerializedProjectionRow[],
  hours: ReadonlySet<string>,
): SerializedProjectionRow[] {
  return rows.filter((row) => hours.has(hourIso(row.hour)));
}

function splitRecentAndBaseline(
  rows: readonly SerializedProjectionRow[],
  now: Date,
): { recentHours: Set<string>; baselineHours: Set<string> } | null {
  const hours = bucketsOf(rows);
  if (hours.length < MIN_RATE_BUCKETS) return null;

  const nowMs = hourMs(now);
  const minMs = hourMs(hours[0] ?? now);
  const spanDays = (nowMs - minMs) / DAY_MS;
  if (spanDays >= 7) {
    const recentCutoff = nowMs - DAY_MS;
    const recentHours = new Set(hours.filter((hour) => hourMs(hour) >= recentCutoff));
    const baselineHours = new Set(
      hours.filter((hour) => {
        const ms = hourMs(hour);
        return ms < recentCutoff && ms >= nowMs - 8 * DAY_MS;
      }),
    );
    if (recentHours.size >= MIN_RATE_BUCKETS && baselineHours.size > 0) {
      return { recentHours, baselineHours };
    }
  }

  const recentHours = new Set(hours.slice(-MIN_RATE_BUCKETS));
  const baselineHours = new Set(hours.slice(0, -MIN_RATE_BUCKETS));
  if (baselineHours.size === 0) return null;
  return { recentHours, baselineHours };
}

function rateAboveBaseline(current: number, baseline: number): boolean {
  if (current <= 0) return false;
  return current > baseline * RATE_RATIO;
}

function abandonedRate(rows: readonly SerializedProjectionRow[]): number {
  const abandoned = countOf(rows.filter((row) => row.event_type === "app.onboarding.abandoned"));
  const states = countOf(rows.filter((row) => row.event_type === "app.onboarding.state"));
  const denom = abandoned + states;
  if (denom === 0) return 0;
  return abandoned / denom;
}

function sendParts(row: SerializedProjectionRow): { channel: string; outcome: string; kind: string } | null {
  if (row.event_type !== "app.thread.send_settled" || !row.payload_class) return null;
  const [channel, outcome, kind] = row.payload_class.split("|");
  if (!channel || !outcome || !kind) return null;
  return { channel, outcome, kind };
}

function sendFailedRate(rows: readonly SerializedProjectionRow[], kind: string): number {
  let failed = 0;
  let total = 0;
  for (const row of rows) {
    const parts = sendParts(row);
    if (!parts || parts.kind !== kind) continue;
    total += row.event_count;
    if (parts.outcome === "failed") failed += row.event_count;
  }
  if (total === 0) return 0;
  return failed / total;
}

function sendSample(rows: readonly SerializedProjectionRow[], kind: string): number {
  let total = 0;
  for (const row of rows) {
    const parts = sendParts(row);
    if (!parts || parts.kind !== kind) continue;
    total += row.event_count;
  }
  return total;
}

function isThreadRoute(row: SerializedProjectionRow): boolean {
  if (row.event_type !== "app.route.viewed" || !row.payload_class) return false;
  return row.payload_class.startsWith("chat|") || row.payload_class.startsWith("channel|");
}

function decisionParts(row: SerializedProjectionRow): { kind: string; decision: string } | null {
  if (row.event_type !== "app.request.decision" || !row.payload_class) return null;
  const [kind, decision] = row.payload_class.split("|");
  if (!kind || !decision) return null;
  return { kind, decision };
}

function windowFromHours(hours: ReadonlySet<string>, now: Date): { start: string; end: string } {
  const sorted = [...hours].sort();
  const start = sorted[0] ?? hourIso(now);
  const last = sorted[sorted.length - 1] ?? start;
  return { start, end: new Date(hourMs(last) + HOUR_MS).toISOString() };
}

function hitForSurface(
  surface: SurfaceRecord | undefined,
  rest: Omit<DetectorHit, "suspectedScope" | "surfaceId"> & { surfaceId: string },
): DetectorHit | null {
  if (!surface) return null;
  return {
    ...rest,
    suspectedScope: [...surface.writable_paths],
  };
}

function detectOnboardingAbandoned(
  rows: readonly SerializedProjectionRow[],
  surfaces: readonly SurfaceRecord[],
  now: Date,
): DetectorHit | null {
  const relevant = rows.filter(
    (row) => row.event_type === "app.onboarding.abandoned" || row.event_type === "app.onboarding.state",
  );
  const split = splitRecentAndBaseline(relevant, now);
  if (!split) return null;
  const recent = inHours(relevant, split.recentHours);
  const baseline = inHours(relevant, split.baselineHours);
  const recentAbandoned = recent.filter((row) => row.event_type === "app.onboarding.abandoned");
  const sampleSize = countOf(recentAbandoned);
  if (sampleSize < MIN_SAMPLE) return null;
  const currentRate = abandonedRate(recent);
  const baselineRate = abandonedRate(baseline);
  if (!rateAboveBaseline(currentRate, baselineRate)) return null;
  return hitForSurface(surfaceById(surfaces, "hc-onboarding-ui"), {
    detectorKey: "app.onboarding.abandoned.rate",
    surfaceId: "hc-onboarding-ui",
    title: "Onboarding abandonment above baseline",
    summary: `Abandoned rate ${currentRate.toFixed(3)} vs baseline ${baselineRate.toFixed(3)} over ${split.recentHours.size} hours.`,
    evidenceTypes: ["app.onboarding.abandoned", "app.onboarding.state"],
    window: windowFromHours(split.recentHours, now),
    sampleSize,
    bucketCount: split.recentHours.size,
    metrics: { current_rate: currentRate, baseline_rate: baselineRate, sample_size: sampleSize },
    roadmapRelevant: true,
  });
}

function detectSendFailed(
  rows: readonly SerializedProjectionRow[],
  surfaces: readonly SurfaceRecord[],
  now: Date,
): DetectorHit[] {
  const relevant = rows.filter((row) => row.event_type === "app.thread.send_settled");
  const split = splitRecentAndBaseline(relevant, now);
  if (!split) return [];
  const recent = inHours(relevant, split.recentHours);
  const baseline = inHours(relevant, split.baselineHours);
  const hits: DetectorHit[] = [];
  for (const kind of ["text", "attachment"] as const) {
    const sampleSize = sendSample(recent, kind);
    if (sampleSize < MIN_SAMPLE) continue;
    const currentRate = sendFailedRate(recent, kind);
    const baselineRate = sendFailedRate(baseline, kind);
    if (!rateAboveBaseline(currentRate, baselineRate)) continue;
    const hit = hitForSurface(surfaceById(surfaces, "hc-thread-ui"), {
      detectorKey: `app.thread.send_settled.failed.${kind}`,
      surfaceId: "hc-thread-ui",
      title: `Thread send failed rate high (${kind})`,
      summary: `Failed ${kind} send rate ${currentRate.toFixed(3)} vs baseline ${baselineRate.toFixed(3)}.`,
      evidenceTypes: ["app.thread.send_settled"],
      window: windowFromHours(split.recentHours, now),
      sampleSize,
      bucketCount: split.recentHours.size,
      metrics: { current_rate: currentRate, baseline_rate: baselineRate, sample_size: sampleSize },
      roadmapRelevant: true,
    });
    if (hit) hits.push(hit);
  }
  return hits;
}

function detectEmptyStateUnescaped(
  rows: readonly SerializedProjectionRow[],
  surfaces: readonly SurfaceRecord[],
  now: Date,
): DetectorHit | null {
  const empty = rows.filter((row) => row.event_type === "app.chat.empty_state");
  const hours = bucketsOf(empty);
  if (hours.length < MIN_RATE_BUCKETS) return null;
  const recentHours = new Set(hours.slice(-MIN_RATE_BUCKETS));
  const recentEmpty = inHours(empty, recentHours);
  const sampleSize = countOf(recentEmpty);
  if (sampleSize < MIN_SAMPLE) return null;
  const views = inHours(rows.filter(isThreadRoute), recentHours);
  const viewCount = countOf(views);
  const maxViews = Math.floor(sampleSize * EMPTY_ESCAPE_MAX_RATIO);
  if (viewCount > maxViews) return null;
  return hitForSurface(surfaceById(surfaces, "hc-chats-ui"), {
    detectorKey: "app.chat.empty_state.unescaped",
    surfaceId: "hc-chats-ui",
    title: "Chat empty state without thread open",
    summary: `${sampleSize} empty-state events across ${recentHours.size} hours with ${viewCount} chat/channel views.`,
    evidenceTypes: ["app.chat.empty_state", "app.route.viewed"],
    window: windowFromHours(recentHours, now),
    sampleSize,
    bucketCount: recentHours.size,
    metrics: { empty_count: sampleSize, chat_channel_views: viewCount },
    roadmapRelevant: true,
  });
}

function detectDeclineHeavy(
  rows: readonly SerializedProjectionRow[],
  surfaces: readonly SurfaceRecord[],
  now: Date,
): DetectorHit | null {
  const relevant = rows.filter((row) => row.event_type === "app.request.decision");
  const hours = bucketsOf(relevant);
  if (hours.length < MIN_RATE_BUCKETS) return null;
  const recentHours = new Set(hours.slice(-MIN_RATE_BUCKETS));
  const recent = inHours(relevant, recentHours);
  let decline = 0;
  let accept = 0;
  for (const row of recent) {
    const parts = decisionParts(row);
    if (!parts) continue;
    if (parts.decision === "decline") decline += row.event_count;
    if (parts.decision === "accept") accept += row.event_count;
  }
  const sampleSize = decline + accept;
  if (sampleSize < MIN_SAMPLE) return null;
  if (decline < accept * DECLINE_RATIO) return null;
  return hitForSurface(surfaceById(surfaces, "hc-chats-ui"), {
    detectorKey: "app.request.decision.decline_heavy",
    surfaceId: "hc-chats-ui",
    title: "Request decisions decline-heavy",
    summary: `${decline} declines vs ${accept} accepts across ${recentHours.size} hours.`,
    evidenceTypes: ["app.request.decision"],
    window: windowFromHours(recentHours, now),
    sampleSize,
    bucketCount: recentHours.size,
    metrics: { decline_count: decline, accept_count: accept },
    roadmapRelevant: true,
  });
}

export function runDetectors(
  rows: readonly SerializedProjectionRow[],
  surfaces: readonly SurfaceRecord[],
  now: Date,
  extraHits: readonly DetectorHit[] = [],
): DetectorHit[] {
  const hits: DetectorHit[] = [];
  const abandoned = detectOnboardingAbandoned(rows, surfaces, now);
  if (abandoned) hits.push(abandoned);
  hits.push(...detectSendFailed(rows, surfaces, now));
  const empty = detectEmptyStateUnescaped(rows, surfaces, now);
  if (empty) hits.push(empty);
  const decline = detectDeclineHeavy(rows, surfaces, now);
  if (decline) hits.push(decline);
  hits.push(...extraHits);
  return hits;
}

export function prepareProblems(
  hits: readonly DetectorHit[],
  surfaces: readonly SurfaceRecord[],
): PreparedProblem[] {
  const prepared: PreparedProblem[] = [];
  for (const hit of hits) {
    const surface = surfaceById(surfaces, hit.surfaceId);
    if (!surface) continue;
    const gates = evaluateGates({
      suspectedScope: hit.suspectedScope,
      surface,
      sampleSize: hit.sampleSize,
      bucketCount: hit.bucketCount,
      minSample: MIN_SAMPLE,
      minBuckets: MIN_RATE_BUCKETS,
      roadmapRelevant: hit.roadmapRelevant,
    });
    prepared.push({
      ...hit,
      qualification: buildQualification({
        gates,
        detectorKey: hit.detectorKey,
        evidenceWindow: hit.window,
        evidenceTypes: hit.evidenceTypes,
        sampleSize: hit.sampleSize,
        bucketCount: hit.bucketCount,
        metrics: hit.metrics,
      }),
    });
  }
  return prepared;
}
