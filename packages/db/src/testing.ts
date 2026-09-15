import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { migrate } from "./migrate.js";
import { schema } from "./schema.js";
import type { Db } from "./tenant.js";

/**
 * Connect-and-migrate for database-backed suites.
 *
 * `pnpm test` stays a no-database, sub-second suite: these tests are gated on
 * DATABASE_URL and skipped when it is unset, so the default experience for a
 * contributor with no Postgres is unchanged. CI sets it, `docker compose up db`
 * then `DATABASE_URL=... pnpm test` is the local equivalent.
 *
 * The connection is whatever DATABASE_URL names — locally the superuser, which
 * bypasses RLS. Any test that means to prove isolation must therefore pass
 * `{ role: "mentorship_app" }` to `withTenant`, or it is testing nothing.
 */

export const DATABASE_URL = process.env["DATABASE_URL"] ?? null;

export interface TestDb {
  db: Db;
  sql: Sql;
  close: () => Promise<void>;
}

export async function connectTestDb(url = DATABASE_URL): Promise<TestDb> {
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  await migrate(sql);
  return {
    sql,
    db: drizzle(sql, { schema }),
    close: () => sql.end(),
  };
}
