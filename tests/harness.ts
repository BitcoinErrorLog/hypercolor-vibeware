import { createApp, type AppOptions } from "../src/app.js";
import type { Config } from "../src/config.js";
import {
  migrate,
  openDatabase,
  resetSchema,
  testDatabaseUrl,
  type Database,
} from "../src/db.js";
import { seedSurfaces } from "../src/seed.js";

export const TEST_INGEST_TOKEN = "test-ingest-token-32chars-min";
export const TEST_DASHBOARD_TOKEN = "test-dashboard-token-32chars";
export const TEST_INTERNAL_TOKEN = "test-internal-token-32chars-ok";
export const TEST_COHORT_KEY = "ab".repeat(32);

export const TEST_INGEST_ORIGIN = "https://hypercolor-web.vercel.app";

export const testConfig: Config = {
  port: 0,
  databaseUrl: undefined,
  ingestToken: TEST_INGEST_TOKEN,
  dashboardToken: TEST_DASHBOARD_TOKEN,
  internalToken: TEST_INTERNAL_TOKEN,
  ingestOrigins: [TEST_INGEST_ORIGIN],
  allowQueryTokenLogin: false,
  insecureCookie: false,
  trustProxy: false,
  nodeEnv: "test",
};

export async function createTestApp(config: Config = testConfig, options: AppOptions = {}) {
  const db = await openDatabase(testDatabaseUrl());
  await resetSchema(db);
  await migrate(db);
  await seedSurfaces(db);
  const app = createApp(db, config, options);
  return { app, db };
}

export async function closeTestApp(db: Database) {
  await db.close();
}

export function ingestHeaders(): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${TEST_INGEST_TOKEN}`);
  headers.set("content-type", "application/json");
  return headers;
}

export function dashboardHeaders(): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${TEST_DASHBOARD_TOKEN}`);
  return headers;
}

export function internalHeaders(): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${TEST_INTERNAL_TOKEN}`);
  return headers;
}

export function socketEnv(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } };
}

export function allowlistedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "app.chat.empty_state",
    occurred_at: new Date().toISOString(),
    surface_id: "hc-chats-ui",
    cohort_key: TEST_COHORT_KEY,
    payload: { kind: "dms" },
    privacy: { contains_user_content: false },
    ...overrides,
  };
}
