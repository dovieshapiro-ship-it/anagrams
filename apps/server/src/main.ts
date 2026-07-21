import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { loadDictionary } from "./dictionary.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);
const app = await buildApp({
  env,
  database,
  dictionary: await loadDictionary(),
});
const shutdown = async (): Promise<void> => {
  await app.close();
  await database.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: env.HOST, port: env.PORT });
