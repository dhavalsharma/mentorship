import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export function createClient(connectionString: string) {
  const sqlClient = postgres(connectionString, { max: 10 });
  return { sqlClient, db: drizzle(sqlClient, { schema }) };
}

/**
 * Every request and every job runs inside a tenant scope — there is no other
 * door. The row-level security policies read `app.current_org`, so a query
 * that forgets its `WHERE` clause returns nothing instead of leaking another
 * organisation's rows.
 *
 * `set_config(..., true)` scopes the setting to the transaction, so a pooled
 * connection cannot carry one tenant's context into the next caller's query.
 */
export async function withTenant<T>(
  db: Db,
  orgId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_org', ${orgId}, true)`,
    );
    return fn(tx as unknown as Db);
  });
}

/**
 * For migrations and the outbox relay, which legitimately cross tenants.
 * Deliberately named so it shows up in a code review.
 */
export async function withoutTenantIsolation<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role mentorship_admin`);
    return fn(tx as unknown as Db);
  });
}
