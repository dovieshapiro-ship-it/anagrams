import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export interface DatabaseHandle {
  readonly db: PostgresJsDatabase<typeof schema>;
  readonly sqlClient: Sql;
  close(): Promise<void>;
}

export function createDatabase(url: string): DatabaseHandle {
  const sqlClient = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return {
    db: drizzle(sqlClient, { schema }),
    sqlClient,
    close: async () => sqlClient.end(),
  };
}
