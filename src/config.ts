import { tokensEqual } from "./tokens.js";

export type Config = {
  port: number;
  databaseUrl: string | undefined;
  ingestToken: string;
  dashboardToken: string;
  internalToken: string;
  ingestOrigins: string[];
  allowQueryTokenLogin: boolean;
  insecureCookie: boolean;
  trustProxy: boolean;
  nodeEnv: string;
};

const DEFAULT_INGEST_ORIGINS = ["https://hypercolor-web.vercel.app"];
const INGEST_ORIGINS_ERROR =
  "VIBEWARE_INGEST_ORIGINS must be a comma-separated list of exact http(s) origins";

function requiredToken(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 16) {
    throw new Error(`${name} must be set to a secret of at least 16 characters`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === "true";
}

function requireDistinctTokens(leftName: string, left: string, rightName: string, right: string): void {
  if (tokensEqual(left, right)) {
    throw new Error(`${leftName} and ${rightName} must be distinct`);
  }
}

function isExactHttpOrigin(value: string): boolean {
  if (value === "" || value === "*" || value === "null") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  if (parsed.hostname === "") {
    return false;
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return false;
  }
  if (parsed.pathname !== "/") {
    return false;
  }
  return value === parsed.origin;
}

function parseIngestOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [...DEFAULT_INGEST_ORIGINS];
  }
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !isExactHttpOrigin(part))) {
    throw new Error(INGEST_ORIGINS_ERROR);
  }
  return parts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = env.PORT ?? "8080";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const ingestToken = requiredToken("VIBEWARE_INGEST_TOKEN", env);
  const dashboardToken = requiredToken("VIBEWARE_DASHBOARD_TOKEN", env);
  const internalToken = requiredToken("VIBEWARE_INTERNAL_TOKEN", env);
  requireDistinctTokens("VIBEWARE_INGEST_TOKEN", ingestToken, "VIBEWARE_DASHBOARD_TOKEN", dashboardToken);
  requireDistinctTokens("VIBEWARE_INGEST_TOKEN", ingestToken, "VIBEWARE_INTERNAL_TOKEN", internalToken);
  requireDistinctTokens("VIBEWARE_DASHBOARD_TOKEN", dashboardToken, "VIBEWARE_INTERNAL_TOKEN", internalToken);
  return {
    port,
    databaseUrl: env.DATABASE_URL || undefined,
    ingestToken,
    dashboardToken,
    internalToken,
    ingestOrigins: parseIngestOrigins(env.VIBEWARE_INGEST_ORIGINS),
    allowQueryTokenLogin: flag(env, "VIBEWARE_ALLOW_QUERY_TOKEN_LOGIN"),
    insecureCookie: flag(env, "VIBEWARE_INSECURE_COOKIE"),
    trustProxy: flag(env, "VIBEWARE_TRUST_PROXY"),
    nodeEnv: env.NODE_ENV ?? "",
  };
}
