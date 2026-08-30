export type Config = {
  port: number;
  databaseUrl: string | undefined;
  ingestToken: string;
  dashboardToken: string;
};

function requiredToken(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 16) {
    throw new Error(`${name} must be set to a secret of at least 16 characters`);
  }
  return value;
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
    ingestToken: requiredToken("VIBEWARE_INGEST_TOKEN"),
    dashboardToken: requiredToken("VIBEWARE_DASHBOARD_TOKEN"),
  };
}
