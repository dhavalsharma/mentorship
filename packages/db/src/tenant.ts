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
export interface TenantOptions {
  /**
   * Drop into an unprivileged role for the transaction. Production connects as
   * `mentorship_app` already, so this is a no-op there. Locally and in CI the
   * connection is the superuser, which bypasses RLS entirely — passing the role
   * is how a test proves the policy bites instead of assuming it does.
   */
  role?: string;
}

export async function withTenant<T>(
  db: Db,
  orgId: string,
  fn: (tx: Db) => Promise<T>,
  options: TenantOptions = {},
): Promise<T> {
  const role = options.role;
  if (role !== undefined && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(role)) {
    // A role name cannot be a bind parameter, so it is interpolated — which
    // makes validating it the difference between a config value and a shell.
    throw new Error(`invalid role name: ${role}`);
  }

  return db.transaction(async (tx) => {
    if (role !== undefined) {
      await tx.execute(sql.raw(`set local role ${role}`));
    }
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
