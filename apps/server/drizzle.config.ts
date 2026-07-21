import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "../../database/migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://anagrams:anagrams@localhost:5432/anagrams",
  },
  strict: true,
});
