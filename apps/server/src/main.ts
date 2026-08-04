import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
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
if (env.NODE_ENV === "production") {
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    wildcard: false,
    setHeaders(response, filePath) {
      if (filePath.endsWith("index.html")) {
        response.setHeader("Cache-Control", "no-store");
      }
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    }
    return reply.header("Cache-Control", "no-store").sendFile("index.html");
  });
}
const shutdown = async (): Promise<void> => {
  await app.close();
  await database.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: env.HOST, port: env.PORT });
