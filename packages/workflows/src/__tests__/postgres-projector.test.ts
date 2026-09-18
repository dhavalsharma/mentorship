import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agreements,
  organizations,
  pairings,
  participants,
  users,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { PostgresProjector } from "@mentorship/workflows/postgres";

/**
 * `pair.thread_bound` is the projection the inbound Slack endpoint depends on:
 * without the channel id landing on the pairing, a message arriving from that
 * channel belongs to nobody. Skipped without DATABASE_URL.
 */

describe.skipIf(!DATABASE_URL)("PostgresProjector — pair.thread_bound", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const cohortId = randomUUID();
  const mentorUser = randomUUID();
  const menteeUser = randomUUID();
  let pairingId: string;

  const event = (channelId: string) => ({
    id: randomUUID(),
    orgId,
    name: "pair.thread_bound" as const,
    subjectRef: `pairing:${pairingId}`,
    occurredAt: new Date().toISOString(),
    version: 1,
    payload: {
      adapterId: "slack",
      channelId,
      threadId: null,
      url: "https://slack.example/C1",
    },
  });

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Proj", slug: `proj-${orgId.slice(0, 8)}` });
    await handle.db.insert(users).values([
      { id: mentorUser, orgId, email: "m@example.com", displayName: "M" },
      { id: menteeUser, orgId, email: "e@example.com", displayName: "E" },
    ]);
    const people = await handle.db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUser, role: "mentor" },
        { orgId, cohortId, userId: menteeUser, role: "mentee" },
      ])
      .returning();
    const [pairing] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId,
        mentorParticipantId: people[0]!.id,
        menteeParticipantId: people[1]!.id,
        state: "active",
        origin: "imported",
        pairKey: `${mentorUser}:${menteeUser}`,
      })
      .returning();
    pairingId = pairing!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(pairings).where(eq(pairings.orgId, orgId));
    await handle.db.delete(participants).where(eq(participants.orgId, orgId));
    await handle.db.delete(users).where(eq(users.orgId, orgId));
    await handle.db.delete(organizations).where(eq(organizations.id, orgId));
    await handle.close();
  });

  it("writes the channel id onto the pairing", async () => {
    const projector = new PostgresProjector(handle.db);
    await projector.apply(event("C-FIRST"));

    const [row] = await handle.db
      .select({ threadRef: pairings.threadRef })
      .from(pairings)
      .where(eq(pairings.id, pairingId));
    expect(row!.threadRef).toMatchObject({
      adapterId: "slack",
      channelId: "C-FIRST",
    });
  });

  it("is idempotent on redelivery and follows a rebound thread", async () => {
    const projector = new PostgresProjector(handle.db);
    await projector.apply(event("C-FIRST"));
    await projector.apply(event("C-SECOND"));
    await projector.apply(event("C-SECOND"));

    const [row] = await handle.db
      .select({ threadRef: pairings.threadRef })
      .from(pairings)
      .where(eq(pairings.id, pairingId));
    expect((row!.threadRef as { channelId: string }).channelId).toBe("C-SECOND");
  });
});

/**
 * The regression for the bug where every `agreements.pairing_id` came out
 * equal to the agreement's own id. `agreement.opened` is the one event this
 * projector handles whose subject ref is *not* pairing-scoped — the effect
 * runner re-subjects any emit carrying an `agreementId` — so the payload is
 * the only correct source. The subject ref below deliberately carries a
 * different id from the payload's `pairingId`, which is what the saga produces
 * in production.
 */
describe.skipIf(!DATABASE_URL)("PostgresProjector — agreement.opened", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const cohortId = randomUUID();
  const mentorUser = randomUUID();
  const menteeUser = randomUUID();
  const agreementId = randomUUID();
  let pairingId: string;
  let participantIds: string[];

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Agr", slug: `agr-${orgId.slice(0, 8)}` });
    await handle.db.insert(users).values([
      { id: mentorUser, orgId, email: "am@example.com", displayName: "AM" },
      { id: menteeUser, orgId, email: "ae@example.com", displayName: "AE" },
    ]);
    const people = await handle.db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUser, role: "mentor" },
        { orgId, cohortId, userId: menteeUser, role: "mentee" },
      ])
      .returning();
    participantIds = people.map((p) => p.id);
    const [pairing] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId,
        mentorParticipantId: people[0]!.id,
        menteeParticipantId: people[1]!.id,
        state: "active",
        origin: "imported",
        pairKey: `${mentorUser}:${menteeUser}`,
      })
      .returning();
    pairingId = pairing!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(agreements).where(eq(agreements.orgId, orgId));
    await handle.db.delete(pairings).where(eq(pairings.orgId, orgId));
    await handle.db.delete(participants).where(eq(participants.orgId, orgId));
    await handle.db.delete(users).where(eq(users.orgId, orgId));
    await handle.db.delete(organizations).where(eq(organizations.id, orgId));
    await handle.close();
  });

  it("takes pairing_id from the payload, not the agreement-scoped subject ref", async () => {
    await new PostgresProjector(handle.db).apply({
      id: randomUUID(),
      orgId,
      name: "agreement.opened",
      subjectRef: `agreement:${agreementId}`,
      occurredAt: new Date().toISOString(),
      version: 1,
      payload: {
        agreementId,
        pairingId,
        participantIds,
        options: [],
        round: 1,
        timeoutAt: new Date().toISOString(),
      },
    });

    const [row] = await handle.db
      .select({ id: agreements.id, pairingId: agreements.pairingId })
      .from(agreements)
      .where(eq(agreements.id, agreementId));

    expect(row!.pairingId).toBe(pairingId);
    expect(row!.pairingId).not.toBe(agreementId);
  });
});
