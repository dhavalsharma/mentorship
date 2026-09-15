import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agreements,
  events,
  identityLinks,
  organizations,
  participants,
  users,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  pendingOutbox,
  PostgresAgreementResponder,
  PostgresChatIdentityResolver,
} from "../postgres-ports.js";

/**
 * The same two ports the Slack route uses, against a real database. Skipped
 * without DATABASE_URL — see packages/db/src/testing.ts.
 */

describe.skipIf(!DATABASE_URL)("the Postgres-backed Slack ports", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const mentorUserId = randomUUID();
  const menteeUserId = randomUUID();
  let mentorParticipantId: string;
  let menteeParticipantId: string;
  let agreementId: string;

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Ports", slug: `ports-${orgId.slice(0, 8)}` });
    await handle.db.insert(users).values([
      { id: mentorUserId, orgId, email: "arjun@example.com", displayName: "Arjun" },
      { id: menteeUserId, orgId, email: "priya@example.com", displayName: "Priya" },
    ]);

    const cohortId = randomUUID();
    const inserted = await handle.db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUserId, role: "mentor" },
        { orgId, cohortId, userId: menteeUserId, role: "mentee" },
      ])
      .returning();
    mentorParticipantId = inserted[0]!.id;
    menteeParticipantId = inserted[1]!.id;

    await handle.db.insert(identityLinks).values([
      {
        orgId,
        userId: mentorUserId,
        provider: "slack",
        externalId: "U-ARJUN",
        verifiedAt: new Date(),
      },
      // Deliberately unverified: an unverified link must not resolve.
      {
        orgId,
        userId: menteeUserId,
        provider: "slack",
        externalId: "U-PRIYA",
        verifiedAt: null,
      },
    ]);

    const [agreement] = await handle.db
      .insert(agreements)
      .values({
        orgId,
        pairingId: randomUUID(),
        subject: "session_time",
        options: [
          { optionId: "opt_1", startsAt: "2026-09-21T09:00:00.000Z", endsAt: "2026-09-21T09:45:00.000Z", label: "Mon" },
          { optionId: "opt_2", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T09:45:00.000Z", label: "Tue" },
        ],
        participantIds: [mentorParticipantId, menteeParticipantId],
        timeoutAt: new Date("2026-09-20T09:00:00.000Z"),
      })
      .returning();
    agreementId = agreement!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(events).where(eq(events.orgId, orgId));
    await handle.db.delete(agreements).where(eq(agreements.orgId, orgId));
    await handle.db.delete(identityLinks).where(eq(identityLinks.orgId, orgId));
    await handle.db.delete(participants).where(eq(participants.orgId, orgId));
    await handle.db.delete(users).where(eq(users.orgId, orgId));
    await handle.db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await handle.close();
  });

  it("resolves a verified Slack id to its participant", async () => {
    const identity = new PostgresChatIdentityResolver({ db: handle.db, orgId });
    expect(await identity.resolveParticipantId("U-ARJUN")).toBe(mentorParticipantId);
  });

  it("refuses to resolve an unverified link", async () => {
    const identity = new PostgresChatIdentityResolver({ db: handle.db, orgId });
    expect(await identity.resolveParticipantId("U-PRIYA")).toBeNull();
  });

  it("returns null for an unknown Slack id", async () => {
    const identity = new PostgresChatIdentityResolver({ db: handle.db, orgId });
    expect(await identity.resolveParticipantId("U-NOBODY")).toBeNull();
  });

  it("records a response and writes the event in the same transaction", async () => {
    const responder = new PostgresAgreementResponder({ db: handle.db, orgId });
    await responder.respond({
      agreementId,
      participantId: mentorParticipantId,
      kind: "accept",
      optionId: "opt_2",
    });

    const [row] = await handle.db
      .select()
      .from(agreements)
      .where(eq(agreements.id, agreementId));
    expect(row!.responses).toEqual([
      expect.objectContaining({
        participantId: mentorParticipantId,
        kind: "accept",
        optionId: "opt_2",
      }),
    ]);

    const outbox = await pendingOutbox(handle.db, orgId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.name).toBe("agreement.responded");
    expect(outbox[0]!.subjectRef).toBe(`agreement:${agreementId}`);
  });

  it("keeps both answers when two people respond", async () => {
    const responder = new PostgresAgreementResponder({ db: handle.db, orgId });
    await responder.respond({
      agreementId,
      participantId: menteeParticipantId,
      kind: "accept",
      optionId: "opt_2",
    });

    const [row] = await handle.db
      .select()
      .from(agreements)
      .where(eq(agreements.id, agreementId));
    const responses = row!.responses as { participantId: string }[];
    expect(responses.map((r) => r.participantId).sort()).toEqual(
      [mentorParticipantId, menteeParticipantId].sort(),
    );
  });

  it("rejects a response from someone who is not a party, and writes nothing", async () => {
    const responder = new PostgresAgreementResponder({ db: handle.db, orgId });
    const before = await pendingOutbox(handle.db, orgId);

    await expect(
      responder.respond({
        agreementId,
        participantId: randomUUID(),
        kind: "accept",
        optionId: "opt_1",
      }),
    ).rejects.toThrow(/not a party/);

    // The transaction rolled back, so the outbox did not grow.
    expect(await pendingOutbox(handle.db, orgId)).toHaveLength(before.length);
  });

  it("rejects an option that was never offered", async () => {
    const responder = new PostgresAgreementResponder({ db: handle.db, orgId });
    await expect(
      responder.respond({
        agreementId,
        participantId: mentorParticipantId,
        kind: "accept",
        optionId: "opt_invented",
      }),
    ).rejects.toThrow(/unknown option/);
  });
});
