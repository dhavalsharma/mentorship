import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import {
  cohorts,
  integrationBindings,
  nudges,
  organizations,
  pairings,
  programs,
  riskFindings,
  withTenant,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { FakeSheet, IntegrationRegistry, Recorder } from "@mentorship/integrations";
import { createWorker, type Worker } from "../worker.js";

/**
 * The report-sync job, end to end on Postgres — the report-sync counterpart
 * to `worker-schedules.test.ts`'s progress-sweep suite. Proves the three
 * things that only make sense against a real database: it runs on its own
 * configured interval (not on every `pass()`), it never reads another org's
 * `risk_findings`/`nudges` rows into this org's spreadsheet, and — the
 * regression case the task spec calls out by name — a second sync reuses the
 * spreadsheet id the first sync created rather than minting a second one.
 */
describe.skipIf(!DATABASE_URL)("worker.sweep() report-sync, on Postgres", () => {
  it("syncs only its own org's rows, on schedule, reusing the created spreadsheet", async () => {
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
          policy: defaultPolicy({ pairing: { mode: "imported" } }),
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
        await withTenant(db, orgId, async (tx) => {
          await tx.insert(riskFindings).values({
            orgId,
            pairingId,
            code: "no_session_in_window",
            severity: "amber",
            detectedAt: new Date("2026-09-01T00:00:00.000Z"),
            summary: `finding for ${orgId}`,
            requiresHuman: true,
          });
          await tx.insert(nudges).values({
            orgId,
            pairingId,
            recipientParticipantId: randomUUID(),
            channel: "slack",
            state: "sent",
            body: `nudge for ${orgId}`,
            dedupeKey: `dk-${orgId}`,
            sentAt: new Date("2026-09-02T00:00:00.000Z"),
          });
        });
      }

      // Only org A has configured a `sheet` destination — a folder id is
      // enough to opt in; no spreadsheet id yet, so the first sync must
      // create one.
      await withTenant(db, orgA, async (tx) => {
        await tx.insert(integrationBindings).values({
          orgId: orgA,
          slot: "sheet",
          adapterId: "google-sheets",
          config: { folderId: "folder_1" },
        });
      });

      const recorder = new Recorder();
      const sheet = new FakeSheet(recorder);
      const registry = new IntegrationRegistry();
      registry.bind(sheet);

      let now = new Date("2026-09-14T06:00:00.000Z").getTime();
      const worker: Worker = createWorker({
        db,
        orgId: orgA,
        registry,
        now: () => new Date(now),
        schedules: { reportSync: { intervalMs: 60_000 } },
      });

      const first = await worker.sweep();
      expect(first.ran).toEqual(["report-sync"]);

      const [binding] = await withTenant(db, orgA, (tx) =>
        tx
          .select()
          .from(integrationBindings)
          .where(and(eq(integrationBindings.orgId, orgA), eq(integrationBindings.slot, "sheet"))),
      );
      const config = binding!.config as { folderId: string; spreadsheetId?: string };
      expect(config.folderId).toBe("folder_1");
      expect(config.spreadsheetId).toBeDefined();
      const spreadsheetId = config.spreadsheetId!;

      const riskTab = sheet.tab(spreadsheetId, "Risk findings");
      expect(riskTab?.rows).toHaveLength(1);
      expect(riskTab?.rows[0]?.[5]).toBe(`finding for ${orgA}`);

      const nudgeTab = sheet.tab(spreadsheetId, "Nudges");
      expect(nudgeTab?.rows).toHaveLength(1);
      expect(nudgeTab?.rows[0]?.[3]).toBe("slack");

      // Immediately again: still inside the interval, so this must be a
      // no-op — the scheduler's own overlap/interval guard, not a fresh sync.
      const second = await worker.sweep();
      expect(second.ran).toEqual([]);

      // Advancing past the interval makes the sweep due again — the
      // regression case: it must reuse the same spreadsheet id rather than
      // creating a second spreadsheet.
      now += 60_000;
      const third = await worker.sweep();
      expect(third.ran).toEqual(["report-sync"]);

      const [rebound] = await withTenant(db, orgA, (tx) =>
        tx
          .select()
          .from(integrationBindings)
          .where(and(eq(integrationBindings.orgId, orgA), eq(integrationBindings.slot, "sheet"))),
      );
      expect((rebound!.config as { spreadsheetId?: string }).spreadsheetId).toBe(spreadsheetId);
      expect(recorder.of("sheet.created")).toHaveLength(1); // only ever created once
    } finally {
      await handle?.close();
    }
  });

  it("is a no-op when no sheet destination is configured for the org", async () => {
    let handle: TestDb | undefined;
    try {
      handle = await connectTestDb();
      const { db } = handle;
      const orgId = randomUUID();
      await db
        .insert(organizations)
        .values({ id: orgId, name: "Org", slug: `org-${orgId.slice(0, 8)}` });

      const registry = new IntegrationRegistry();
      registry.bind(new FakeSheet(new Recorder()));

      const worker: Worker = createWorker({
        db,
        orgId,
        registry,
        schedules: { reportSync: { intervalMs: 60_000 } },
      });

      // Runs (the scheduler considers it "ran" — the job itself decided
      // there was nothing to do), but writes nothing anywhere.
      const result = await worker.sweep();
      expect(result.ran).toEqual(["report-sync"]);
    } finally {
      await handle?.close();
    }
  });
});
