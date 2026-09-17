import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, pairings, participants, users } from "@mentorship/db";
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
