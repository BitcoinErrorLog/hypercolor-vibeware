import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db.js";
import { startGcSchedule } from "./gc.js";
import { seedSurfaces } from "./seed.js";

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error("DATABASE_URL must be set");
}

const db = await openDatabase(config.databaseUrl);
await migrate(db);
await seedSurfaces(db);
startGcSchedule(db);

const app = createApp(db, config);
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`hypercolor-vibeware listening on ${info.port}`);
});
