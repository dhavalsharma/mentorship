import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, sessionNotes } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { PostgresSessionSourceStore } from "@mentorship/workflows/postgres";

/**
 * Bug #9 in docs/e2e-testing-strategy.md, at the database: a fetched
 * transcript is stored once per (session, vendor ref) however often the fetch
 * is retried — including concurrently — and is readable by a fresh store (a
 * restarted worker) only within its own org. The in-memory parity half is
 * `World` in testkit, exercised by session-lifecycle.test.ts. Skipped without
 * DATABASE_URL.
 */

describe.skipIf(!DATABASE_URL)("PostgresSessionSourceStore — transcripts", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Sources", slug: `sources-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Sources2", slug: `sources-${otherOrgId.slice(0, 8)}` },
    ]);
  });

  afterAll(async () => {
    if (!handle) return;
    for (const id of [orgId, otherOrgId]) {
      await handle.db.delete(sessionNotes).where(eq(sessionNotes.orgId, id));
      await handle.db.delete(organizations).where(eq(organizations.id, id));
    }
    await handle.close();
  });

  const store = (org: string) =>
    new PostgresSessionSourceStore(handle.db, { orgId: org, role: "mentorship_app" });

  it("stores a retried fetch once, and a fresh store reads it back, under RLS", async () => {
    const sessionId = randomUUID();
    const ref = `transcript_${randomUUID()}`;
    await Promise.all([
      store(orgId).recordTranscript({ sessionId, ref, body: "Priya: first" }),
      store(orgId).recordTranscript({ sessionId, ref, body: "Priya: first" }),
      store(orgId).recordTranscript({ sessionId, ref, body: "Priya: first" }),
    ]);
    await store(orgId).recordTranscript({ sessionId, ref, body: "a later retry" });

    const rows = await handle.db
      .select()
      .from(sessionNotes)
      .where(eq(sessionNotes.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "transcript", externalRef: ref, orgId });

    expect(await store(orgId).transcript({ sessionId, ref })).toBe("Priya: first");
    expect(await store(orgId).transcript({ sessionId, ref: "other" })).toBeNull();
  });

  it("never reads another org's transcript", async () => {
    const sessionId = randomUUID();
    const ref = `transcript_${randomUUID()}`;
    await store(orgId).recordTranscript({ sessionId, ref, body: "private" });
    expect(await store(otherOrgId).transcript({ sessionId, ref })).toBeNull();
  });
});
