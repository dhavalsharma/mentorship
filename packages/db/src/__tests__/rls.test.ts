import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, pairings, withTenant, withoutTenantIsolation } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";

/**
 * The cross-tenant leak test. RLS is the entire tenancy story — application
 * code never filters by `org_id` itself — so "we wrote a policy" is worth
 * nothing until something proves the policy bites. 0002_rls.sql says as much
 * in a comment; this is that comment, executable.
 *
 * Skipped without DATABASE_URL so the default suite stays database-free:
 *   docker compose up -d db
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/mentorship pnpm test
 */

const APP_ROLE = "mentorship_app";

describe.skipIf(!DATABASE_URL)("row-level security", () => {
  let handle: TestDb;
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    handle = await connectTestDb();
    // Seeded on the superuser connection, which bypasses RLS — that is the
    // only way to set up two tenants' data in the first place.
    await handle.db.insert(organizations).values([
      { id: orgA, name: "Org A", slug: `org-a-${orgA.slice(0, 8)}` },
      { id: orgB, name: "Org B", slug: `org-b-${orgB.slice(0, 8)}` },
    ]);
    await handle.db.insert(pairings).values([
      pairing(orgA, "a:1"),
      pairing(orgA, "a:2"),
      pairing(orgB, "b:1"),
    ]);
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(pairings).where(inArray(pairings.orgId, [orgA, orgB]));
    await handle.db
      .delete(organizations)
      .where(inArray(organizations.id, [orgA, orgB]));
    await handle.close();
  });

  it("shows a tenant only its own rows", async () => {
    const rows = await withTenant(
      handle.db,
      orgA,
      async (tx) => tx.select().from(pairings),
      { role: APP_ROLE },
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orgId === orgA)).toBe(true);
  });

  it("returns zero rows for another org even when asked for it by id", async () => {
    // The forgotten-WHERE case, inverted: here the WHERE is deliberately
    // wrong. The policy has to make it empty rather than merely unlikely.
    const rows = await withTenant(
      handle.db,
      orgA,
      async (tx) => tx.select().from(pairings).where(eq(pairings.orgId, orgB)),
      { role: APP_ROLE },
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a write stamped with another org's id", async () => {
    await expect(
      withTenant(
        handle.db,
        orgA,
        async (tx) => tx.insert(pairings).values(pairing(orgB, "smuggled")),
        { role: APP_ROLE },
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("sees nothing at all when no org is set", async () => {
    const rows = await withTenant(
      handle.db,
      "00000000-0000-0000-0000-000000000000",
      async (tx) => tx.select().from(pairings),
      { role: APP_ROLE },
    );
    expect(rows).toHaveLength(0);
  });

  it("lets the admin role cross tenants, for the relay", async () => {
    // Without 0004's admin policy this returns zero rather than everything,
    // because FORCE RLS applies to the owner too and an unset `app.current_org`
    // makes the predicate NULL. A relay reading zero rows looks like an idle
    // queue, which is the worst way for this to fail.
    const rows = await withoutTenantIsolation(handle.db, async (tx) =>
      tx.select().from(pairings).where(inArray(pairings.orgId, [orgA, orgB])),
    );
    expect(rows).toHaveLength(3);
  });

  it("rejects a role name that is not an identifier", async () => {
    await expect(
      withTenant(handle.db, orgA, async () => null, {
        role: "app; drop table pairings",
      }),
    ).rejects.toThrow(/invalid role name/);
  });
});

function pairing(orgId: string, pairKey: string) {
  return {
    orgId,
    cohortId: randomUUID(),
    mentorParticipantId: randomUUID(),
    menteeParticipantId: randomUUID(),
    pairKey,
    state: "active",
    origin: "imported",
  };
}
