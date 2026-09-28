import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { events, organizations, sagaInstances } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  listDeadLetteredEvents,
  listStuckSagaInstances,
} from "@mentorship/workflows/postgres";

/**
 * The admin monitoring gap ROADMAP phase 1 names: "saga instances not
 * advanced in N days; dead-letter review." These queries are the data side
 * of that — `apps/api`'s routes are thin wrappers over them.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

describe.skipIf(!DATABASE_URL)("admin monitoring reads", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const NOW = new Date("2026-09-22T12:00:00.000Z");

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Reads Org", slug: `reads-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Other Org", slug: `other-${otherOrgId.slice(0, 8)}` },
    ]);
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(sagaInstances).where(eq(sagaInstances.orgId, orgId));
    await handle.db.delete(sagaInstances).where(eq(sagaInstances.orgId, otherOrgId));
    await handle.db.delete(events).where(eq(events.orgId, orgId));
    await handle.db.delete(events).where(eq(events.orgId, otherOrgId));
    await handle.db
      .delete(organizations)
      .where(eq(organizations.id, orgId));
    await handle.db
      .delete(organizations)
      .where(eq(organizations.id, otherOrgId));
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.delete(sagaInstances).where(eq(sagaInstances.orgId, orgId));
    await handle.db.delete(sagaInstances).where(eq(sagaInstances.orgId, otherOrgId));
    await handle.db.delete(events).where(eq(events.orgId, orgId));
    await handle.db.delete(events).where(eq(events.orgId, otherOrgId));
  });

  async function seedSaga(
    forOrgId: string,
    status: "running" | "done" | "failed",
    updatedAt: Date,
  ): Promise<string> {
    const [row] = await handle.db
      .insert(sagaInstances)
      .values({
        orgId: forOrgId,
        sagaName: "SessionLifecycle",
        subjectRef: `pairing:${randomUUID()}`,
        state: { name: "awaitingResponse" },
        version: 0,
        stepIndex: 0,
        status,
        updatedAt,
      })
      .returning();
    return row!.id;
  }

  async function seedEvent(
    forOrgId: string,
    deadLetteredAt: Date | null,
    occurredAt: Date,
  ): Promise<string> {
    const [row] = await handle.db
      .insert(events)
      .values({
        orgId: forOrgId,
        name: "pair.activated",
        subjectRef: `pairing:${randomUUID()}`,
        occurredAt,
        payload: {},
        deadLetteredAt,
      })
      .returning();
    return row!.id;
  }

  describe("listStuckSagaInstances", () => {
    it("returns running instances older than the threshold, oldest first", async () => {
      const veryStale = await seedSaga(
        orgId,
        "running",
        new Date("2026-09-01T00:00:00.000Z"),
      );
      const stale = await seedSaga(
        orgId,
        "running",
        new Date("2026-09-10T00:00:00.000Z"),
      );
      await seedSaga(orgId, "running", new Date("2026-09-21T00:00:00.000Z")); // recent, not stuck

      const rows = await listStuckSagaInstances(handle.db, orgId, {
        olderThanDays: 3,
        limit: 50,
        now: () => NOW,
      });

      expect(rows.map((r) => (r as { id: string }).id)).toEqual([veryStale, stale]);
    });

    it("excludes done instances even when very old", async () => {
      await seedSaga(orgId, "done", new Date("2026-01-01T00:00:00.000Z"));

      const rows = await listStuckSagaInstances(handle.db, orgId, {
        olderThanDays: 3,
        limit: 50,
        now: () => NOW,
      });

      expect(rows).toEqual([]);
    });

    // `failed` is the engine's parking marker (a timer step that kept
    // throwing), so it is stuck by definition — however recently it parked.
    it("includes failed (parked) instances regardless of age", async () => {
      const parked = await seedSaga(orgId, "failed", new Date("2026-09-22T23:00:00.000Z"));

      const rows = await listStuckSagaInstances(handle.db, orgId, {
        olderThanDays: 3,
        limit: 50,
        now: () => NOW,
      });

      expect(rows.map((r) => (r as { id: string }).id)).toEqual([parked]);
    });

    it("never returns another org's instances", async () => {
      await seedSaga(otherOrgId, "running", new Date("2026-01-01T00:00:00.000Z"));

      const rows = await listStuckSagaInstances(handle.db, orgId, {
        olderThanDays: 3,
        limit: 50,
        now: () => NOW,
      });

      expect(rows).toEqual([]);
    });

    it("defaults to 3 days and respects the limit", async () => {
      for (let i = 0; i < 3; i++) {
        await seedSaga(orgId, "running", new Date("2026-01-01T00:00:00.000Z"));
      }

      const rows = await listStuckSagaInstances(handle.db, orgId, {
        limit: 2,
        now: () => NOW,
      });

      expect(rows).toHaveLength(2);
    });
  });

  describe("listDeadLetteredEvents", () => {
    it("returns only dead-lettered events, most recently parked first", async () => {
      const older = await seedEvent(
        orgId,
        new Date("2026-09-01T00:00:00.000Z"),
        new Date("2026-08-01T00:00:00.000Z"),
      );
      const newer = await seedEvent(
        orgId,
        new Date("2026-09-15T00:00:00.000Z"),
        new Date("2026-08-15T00:00:00.000Z"),
      );
      await seedEvent(orgId, null, new Date("2026-08-20T00:00:00.000Z")); // never parked

      const rows = await listDeadLetteredEvents(handle.db, orgId, { limit: 50 });

      expect(rows.map((r) => (r as { id: string }).id)).toEqual([newer, older]);
    });

    it("never returns another org's dead letters", async () => {
      await seedEvent(otherOrgId, new Date("2026-09-01T00:00:00.000Z"), new Date());

      const rows = await listDeadLetteredEvents(handle.db, orgId, { limit: 50 });

      expect(rows).toEqual([]);
    });
  });
});
