import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { loadEnv } from "./env.js";

const databaseUrl = "postgres://unused:unused@127.0.0.1:1/unused";

describe("public operational routes", () => {
  it("serves liveness and generated OpenAPI without touching PostgreSQL", async () => {
    const database = createDatabase(databaseUrl);
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
        WEB_ORIGINS: "http://localhost:3000",
        PUBLIC_WEB_URL: "http://localhost:3000",
        COOKIE_SECURE: "false",
      }),
      database,
      dictionary: { has: () => false, words: () => [] },
    });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        status: "ok",
        service: "anagrams-server",
        version: "0.1.0",
      });

      const spec = await app.inject({ method: "GET", url: "/docs/json" });
      expect(spec.statusCode).toBe(200);
      expect(spec.json()).toMatchObject({
        info: { title: "Anagrams API", version: "1.0.0" },
      });
    } finally {
      await app.close();
      await database.close();
    }
  });

  it("rejects protected mutations before database work when origin is absent", async () => {
    const database = createDatabase(databaseUrl);
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
        WEB_ORIGINS: "http://localhost:3000",
        PUBLIC_WEB_URL: "http://localhost:3000",
        COOKIE_SECURE: "false",
      }),
      database,
      dictionary: { has: () => false, words: () => [] },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/games",
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "ORIGIN_REJECTED" },
      });
    } finally {
      await app.close();
      await database.close();
    }
  });
});
