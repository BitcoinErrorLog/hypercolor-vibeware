export type Config = {
  port: number;
  databaseUrl: string | undefined;
  ingestToken: string;
  dashboardToken: string;
  internalToken: string;
  allowQueryTokenLogin: boolean;
  insecureCookie: boolean;
  trustProxy: boolean;
  nodeEnv: string;
};

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = env.PORT ?? "8080";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return {
    port,
    databaseUrl: env.DATABASE_URL || undefined,
    ingestToken: requiredToken("VIBEWARE_INGEST_TOKEN", env),
    dashboardToken: requiredToken("VIBEWARE_DASHBOARD_TOKEN", env),
    internalToken: requiredToken("VIBEWARE_INTERNAL_TOKEN", env),
    allowQueryTokenLogin: flag(env, "VIBEWARE_ALLOW_QUERY_TOKEN_LOGIN"),
    insecureCookie: flag(env, "VIBEWARE_INSECURE_COOKIE"),
    trustProxy: flag(env, "VIBEWARE_TRUST_PROXY"),
    nodeEnv: env.NODE_ENV ?? "",
  };
}
