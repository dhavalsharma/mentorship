import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import { cohorts, organizations, pairings, programs, riskFindings } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { IntegrationRegistry } from "@mentorship/integrations";
import { createWorker, type Worker } from "../worker.js";

/**
 * The scheduled progress sweep, end to end on Postgres: proves the three
 * things the task asked for that only make sense against a real database —
 * it runs on the configured schedule (not on every `pass()`), it is safe to
 * call back to back (the second call inside one interval is a no-op, not a
 * second write), and it never reaches a pairing that belongs to another org.
 *
 * The nudge sweep and the digest are covered by unit tests elsewhere
 * (`scheduler.test.ts`, `digest.test.ts`) plus their own primitive-level
 * suites; this one exercises the Postgres wiring
 * (`createProgressSweepRunner`, `listActivePairingsByCohort`,
 * `PostgresProgressReader`) that only a real database can prove correct.
 * Skipped without DATABASE_URL, same as every other Postgres suite here.
 */
describe.skipIf(!DATABASE_URL)("worker.sweep(), on Postgres", () => {
  it("assesses only its own org's active pairings, and does not double-run inside one interval", async () => {
    let handle: TestDb | undefined;
    try {
      handle = await connectTestDb();
      const { db } = handle;

      const orgA = randomUUID();
      const orgB = randomUUID();
      const pairingIds: Record<string, string> = {};

      for (const orgId of [orgA, orgB]) {
        await db
          .insert(organizations)
          .values({ id: orgId, name: "Org", slug: `org-${orgId.slice(0, 8)}` });
        const programId = randomUUID();
        const cohortId = randomUUID();
        await db.insert(programs).values({
          id: programId,
          orgId,
          name: "Career Mentoring",
          policy: defaultPolicy({
            pairing: { mode: "imported" },
            cadence: { everyDays: 14, label: "fortnightly", reminderLeadHours: 24 },
          }),
        });
        await db.insert(cohorts).values({
          id: cohortId,
          orgId,
          programId,
          name: "2026 H2",
          startsAt: new Date("2026-01-01T00:00:00.000Z"),
          endsAt: new Date("2026-12-31T00:00:00.000Z"),
        });

        const pairingId = randomUUID();
        pairingIds[orgId] = pairingId;
        await db.insert(pairings).values({
          id: pairingId,
          orgId,
          cohortId,
          mentorParticipantId: randomUUID(),
          menteeParticipantId: randomUUID(),
          state: "active",
          origin: "imported",
          pairKey: `mentor-mentee-${pairingId.slice(0, 8)}`,
        });
      }

      const registry = new IntegrationRegistry();
      let now = new Date("2026-09-14T06:00:00.000Z").getTime();
      const worker: Worker = createWorker({
        db,
        orgId: orgA,
        registry,
        now: () => new Date(now),
        schedules: { progress: { intervalMs: 60_000 } },
      });

      const first = await worker.sweep();
      expect(first.ran).toEqual(["progress"]);

      // Immediately again: still inside the interval, so this must be a
      // no-op — the scheduler's own guard, not a fresh Postgres round trip.
      const second = await worker.sweep();
      expect(second.ran).toEqual([]);

      // A pairing with no sessions, no action items and no goals is exactly
      // "insufficient data" — the default rule set may or may not fire a
      // finding for that on its own, but whatever it decides for org A must
      // never appear against org B's pairing, which this worker was never
      // configured to touch.
      const orgBFindings = await db
        .select()
        .from(riskFindings)
        .where(eq(riskFindings.pairingId, pairingIds[orgB]!));
      expect(orgBFindings).toHaveLength(0);

      // Advancing past the interval makes the sweep due again.
      now += 60_000;
      const third = await worker.sweep();
      expect(third.ran).toEqual(["progress"]);
    } finally {
      await handle?.close();
    }
  });
});
