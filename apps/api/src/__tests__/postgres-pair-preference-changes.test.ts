import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import {
  cohorts,
  events,
  organizations,
  pairings,
  participants,
  programs,
  users,
  withTenant,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { PostgresPairPreferencesStore } from "../postgres-ports.js";
import { listPairPreferenceChanges } from "../postgres-reads.js";

/**
 * ADR-0009 action 7 on a real database, as `mentorship_app` so RLS is live:
 * a change made through the same store the Slack modal writes through shows
 * up in the admin read with the pair's names and the program's own default,
 * and another org's change never does — not even when this org's event log
 * names that org's pairing.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

const ROLE = "mentorship_app";
const NOW = new Date("2026-09-20T10:00:00.000Z");

interface SeededOrg {
  orgId: string;
  pairingId: string;
  mentorParticipantId: string;
  menteeParticipantId: string;
}

describe.skipIf(!DATABASE_URL)("pair preference changes on Postgres", () => {
  let handle: TestDb;
  const orgIds: string[] = [];
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  async function seedOrg(label: string, cohortOverride: object | null): Promise<SeededOrg> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    const db = handle.db;
    await db
      .insert(organizations)
      .values({ id: orgId, name: label, slug: `ppc-${orgId.slice(0, 8)}` });
    const programId = randomUUID();
    const cohortId = randomUUID();
    await db.insert(programs).values({ id: programId, orgId, name: "Mentoring", policy: defaultPolicy() });
    await db.insert(cohorts).values({
      id: cohortId,
      orgId,
      programId,
      name: "2026 H2",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-12-31T00:00:00.000Z"),
      cadenceOverride: cohortOverride,
    });
    const mentorUserId = randomUUID();
    const menteeUserId = randomUUID();
    await db.insert(users).values([
      { id: mentorUserId, orgId, email: `mentor-${orgId}@example.com`, displayName: `${label} Mentor` },
      { id: menteeUserId, orgId, email: `mentee-${orgId}@example.com`, displayName: `${label} Mentee` },
    ]);
    const [mentor, mentee] = await db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUserId, role: "mentor" },
        { orgId, cohortId, userId: menteeUserId, role: "mentee" },
      ])
      .returning();
    const [pairing] = await db
      .insert(pairings)
      .values({
        orgId,
        cohortId,
        mentorParticipantId: mentor!.id,
        menteeParticipantId: mentee!.id,
        state: "active",
        origin: "imported",
        pairKey: `${mentorUserId}:${menteeUserId}`,
      })
      .returning();
    return {
      orgId,
      pairingId: pairing!.id,
      mentorParticipantId: mentor!.id,
      menteeParticipantId: mentee!.id,
    };
  }

  beforeAll(async () => {
    handle = await connectTestDb();
    // Org A's cohort runs weekly, so its program default is 45 min / 7 days —
    // proving the default reads the cohort override, not only the program.
    orgA = await seedOrg("Alpha", { everyDays: 7 });
    orgB = await seedOrg("Beta", null);

    const store = (org: SeededOrg) =>
      new PostgresPairPreferencesStore({ db: handle.db, orgId: org.orgId, role: ROLE, now: () => NOW });
    expect(
      await store(orgA).update({
        pairingId: orgA.pairingId,
        participantId: orgA.menteeParticipantId,
        preferences: { sessionMinutes: 30 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store(orgB).update({
        pairingId: orgB.pairingId,
        participantId: orgB.mentorParticipantId,
        preferences: { everyDays: 28 },
      }),
    ).toMatchObject({ ok: true });
  });

  afterAll(async () => {
    if (!handle) return;
    const db = handle.db;
    for (const table of [events, pairings, participants, users, cohorts, programs]) {
      await db.delete(table).where(inArray(table.orgId, orgIds));
    }
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await handle.close();
  });

  it("shows a real change with the pair's names, who made it, and the program default", async () => {
    const result = await listPairPreferenceChanges(handle.db, orgA.orgId, 50, ROLE);
    expect(result).toEqual({
      skipped: 0,
      changes: [
        {
          eventId: expect.any(String),
          occurredAt: NOW.toISOString(),
          pairingId: orgA.pairingId,
          mentorName: "Alpha Mentor",
          menteeName: "Alpha Mentee",
          changedBy: { participantId: orgA.menteeParticipantId, displayName: "Alpha Mentee" },
          changed: { sessionMinutes: 30 },
          result: { sessionMinutes: 30, everyDays: 7 },
          programDefault: { sessionMinutes: 45, everyDays: 7 },
          differsFromProgramDefault: true,
        },
      ],
    });
  });

  it("never shows another org's change, nor resolves its people from a forged payload", async () => {
    const other = await listPairPreferenceChanges(handle.db, orgB.orgId, 50, ROLE);
    expect(other.changes.map((c) => c.pairingId)).toEqual([orgB.pairingId]);

    // An event in org A naming org B's pairing and participant: RLS makes
    // them unresolvable, so the row shows nulls, never Beta's names.
    await withTenant(
      handle.db,
      orgA.orgId,
      (tx) =>
        tx.insert(events).values({
          orgId: orgA.orgId,
          name: "pair.preferences_updated",
          subjectRef: `pairing:${orgB.pairingId}`,
          occurredAt: new Date(NOW.getTime() + 60_000),
          payload: {
            pairingId: orgB.pairingId,
            participantId: orgB.mentorParticipantId,
            sessionMinutes: 45,
            everyDays: 28,
            changed: { everyDays: 28 },
          },
        }),
      { role: ROLE },
    );
    const mine = await listPairPreferenceChanges(handle.db, orgA.orgId, 50, ROLE);
    expect(mine.changes).toHaveLength(2);
    expect(mine.changes[0]).toMatchObject({
      pairingId: orgB.pairingId,
      mentorName: null,
      menteeName: null,
      changedBy: { displayName: null },
      programDefault: null,
    });
    expect(JSON.stringify(mine)).not.toContain("Beta");
  });

  it("skips and counts a malformed event instead of failing the read", async () => {
    await withTenant(
      handle.db,
      orgA.orgId,
      (tx) =>
        tx.insert(events).values({
          orgId: orgA.orgId,
          name: "pair.preferences_updated",
          subjectRef: `pairing:${orgA.pairingId}`,
          occurredAt: new Date(NOW.getTime() + 120_000),
          payload: { pairingId: "not-a-uuid", everyDays: "weekly" },
        }),
      { role: ROLE },
    );
    const result = await listPairPreferenceChanges(handle.db, orgA.orgId, 50, ROLE);
    expect(result.skipped).toBe(1);
    expect(result.changes).toHaveLength(2);
    // Newest first; limit bounds the events read, malformed included.
    const limited = await listPairPreferenceChanges(handle.db, orgA.orgId, 2, ROLE);
    expect(limited).toMatchObject({ skipped: 1, changes: [{ pairingId: orgB.pairingId }] });
  });
});
