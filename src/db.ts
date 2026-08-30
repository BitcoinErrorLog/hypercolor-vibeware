import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { SCHEMA_STATEMENTS, TEST_RESET_STATEMENTS } from "./schema.js";

export type SqlParams = readonly unknown[];

export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<T[]>;
  close(): Promise<void>;
}

export function createPgDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString });
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: SqlParams = []) {
      const result = await pool.query(sql, [...params]);
      return result.rows as T[];
    },
    async close() {
      await pool.end();
    },
  };
}

export function createPgliteDatabase(client: PGlite): Database {
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: SqlParams = []) {
      const result = await client.query<T>(sql, [...params]);
      return result.rows;
    },
    async close() {
      await client.close();
    },
  };
}

export async function migrate(db: Database): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.query(statement);
  }
}

export async function resetSchema(db: Database): Promise<void> {
  for (const statement of TEST_RESET_STATEMENTS) {
    await db.query(statement);
  }
}

export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.VIBEWARE_TEST_DATABASE_URL) return env.VIBEWARE_TEST_DATABASE_URL;
  const url = env.DATABASE_URL;
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function openDatabase(databaseUrl: string | undefined): Promise<Database> {
  if (databaseUrl) {
    return createPgDatabase(databaseUrl);
  }
  const pglite = new PGlite();
  return createPgliteDatabase(pglite);
}
