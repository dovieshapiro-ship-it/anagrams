import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./db/client.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);
const migrationsFolder = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);

try {
  await migrate(database.db, { migrationsFolder });
} finally {
  await database.close();
}
