import type { Database } from "./db.js";

export type SurfaceRecord = {
  id: string;
  owner: string;
  writable_paths: string[];
  forbidden_paths: string[];
  max_initial_percent: number;
  requires_human_for_percent_over: number;
  minimum_exposure_hours: number;
  primary_metric: string;
  guardrails: string[];
};

type ManifestScope = {
  writable_paths?: unknown;
  forbidden_paths?: unknown;
};

type ManifestExposure = {
  max_initial_percent?: unknown;
  requires_human_for_percent_over?: unknown;
};

type ManifestSelection = {
  minimum_exposure_hours?: unknown;
  primary_metric?: unknown;
  guardrails?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseSurface(row: { id: string; owner: string; manifest: unknown }): SurfaceRecord {
  const manifest = asRecord(row.manifest);
  const scope = asRecord(manifest.scope) as ManifestScope;
  const exposure = asRecord(manifest.exposure) as ManifestExposure;
  const selection = asRecord(manifest.selection) as ManifestSelection;
  return {
    id: row.id,
    owner: row.owner,
    writable_paths: asStringList(scope.writable_paths),
    forbidden_paths: asStringList(scope.forbidden_paths),
    max_initial_percent: asPositiveInt(exposure.max_initial_percent, 10),
    requires_human_for_percent_over: asPositiveInt(exposure.requires_human_for_percent_over, 25),
    minimum_exposure_hours: asPositiveInt(selection.minimum_exposure_hours, 48),
    primary_metric: typeof selection.primary_metric === "string" ? selection.primary_metric : "",
    guardrails: asStringList(selection.guardrails),
  };
}

export async function loadSurfaces(db: Database): Promise<SurfaceRecord[]> {
  const rows = await db.query<{ id: string; owner: string; manifest: unknown }>(
    `SELECT id, owner, manifest FROM vibeware_surfaces ORDER BY id`,
  );
  return rows.map(parseSurface);
}

export async function loadSurface(db: Database, id: string): Promise<SurfaceRecord | undefined> {
  const rows = await db.query<{ id: string; owner: string; manifest: unknown }>(
    `SELECT id, owner, manifest FROM vibeware_surfaces WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? parseSurface(row) : undefined;
}

export function surfaceById(surfaces: readonly SurfaceRecord[], id: string): SurfaceRecord | undefined {
  return surfaces.find((surface) => surface.id === id);
}
