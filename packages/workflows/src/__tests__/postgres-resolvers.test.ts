import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import {
  agreements,
  cohorts,
  consents,
  identityLinks,
  integrationBindings,
  organizations,
  pairings,
  participants,
  programs,
  users,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { FakeCalendar, IntegrationRegistry, Recorder } from "@mentorship/integrations";
import { PostgresSagaResolvers } from "@mentorship/workflows/postgres";

/**
 * The Postgres counterpart to `testkit`'s `World`. What matters is that it
 * assembles the same `PairContext` the sagas already assume, and that the two
 * judgement calls inside it hold: an unverified chat link is not a member ref,
 * and consent absent means consent not given.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

describe.skipIf(!DATABASE_URL)("PostgresSagaResolvers", () => {
  let handle: TestDb;
  let resolvers: PostgresSagaResolvers;
  const orgId = randomUUID();
  const programId = randomUUID();
  const cohortId = randomUUID();
  const mentorUser = randomUUID();
  const menteeUser = randomUUID();
  let pairingId: string;
  let mentorId: string;
  let menteeId: string;

  const policy = defaultPolicy({
    pairing: { mode: "imported", mentorCapacityDefault: 2 },
    cadence: { everyDays: 14, label: "fortnightly", reminderLeadHours: 24 },
  });

  beforeAll(async () => {
    handle = await connectTestDb();
    const registry = new IntegrationRegistry();
    registry.bind(new FakeCalendar(new Recorder(), {}));
    resolvers = new PostgresSagaResolvers({ db: handle.db, orgId, registry });

    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Resolvers", slug: `res-${orgId.slice(0, 8)}` });
    await handle.db
      .insert(programs)
      .values({ id: programId, orgId, name: "Career Mentoring", policy });
    await handle.db.insert(cohorts).values({
      id: cohortId,
      orgId,
      programId,
      name: "2026 H2",
      startsAt: new Date("2026-07-01T00:00:00Z"),
      endsAt: new Date("2026-12-31T00:00:00Z"),
    });
    await handle.db.insert(users).values([
      {
        id: mentorUser,
        orgId,
        email: "arjun@example.com",
        displayName: "Arjun Rao",
        tzOffsetMinutes: 330,
      },
      {
        id: menteeUser,
        orgId,
        email: "priya@example.com",
        displayName: "Priya Menon",
        tzOffsetMinutes: 330,
      },
    ]);

    const people = await handle.db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUser, role: "mentor" },
        { orgId, cohortId, userId: menteeUser, role: "mentee" },
      ])
      .returning();
    mentorId = people[0]!.id;
    menteeId = people[1]!.id;

    await handle.db.insert(identityLinks).values([
      {
        orgId,
        userId: mentorUser,
        provider: "slack",
        externalId: "U-ARJUN",
        verifiedAt: new Date(),
      },
      // Unverified on purpose — it must not become a member ref.
      {
        orgId,
        userId: menteeUser,
        provider: "slack",
        externalId: "U-PRIYA",
        verifiedAt: null,
      },
    ]);

    await handle.db.insert(consents).values([
      { orgId, participantId: mentorId, kind: "ai_processing", granted: true },
      // Granted then revoked: revocation has to outrank the grant.
      {
        orgId,
        participantId: mentorId,
        kind: "recording",
        granted: true,
        revokedAt: new Date(),
      },
      { orgId, participantId: menteeId, kind: "ai_processing", granted: true },
    ]);

    const [pair] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId,
        mentorParticipantId: mentorId,
        menteeParticipantId: menteeId,
        pairKey: "arjun|priya",
        state: "active",
        origin: "imported",
        cadenceOverride: { everyDays: 21, label: "every 21 days" },
        lastSessionAt: new Date("2026-09-01T09:00:00Z"),
        documentRef: "doc_42",
      })
      .returning();
    pairingId = pair!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    for (const table of [
      agreements,
      pairings,
      consents,
      identityLinks,
      participants,
      users,
      cohorts,
      programs,
      integrationBindings,
    ]) {
      await handle.db.delete(table).where(eq(table.orgId, orgId));
    }
    await handle.db.delete(organizations).where(eq(organizations.id, orgId));
    await handle.close();
  });

  it("assembles the pair context the sagas expect", async () => {
    const context = await resolvers.pairContext(pairingId);

    expect(context.pairingId).toBe(pairingId);
    expect(context.orgId).toBe(orgId);
    expect(context.title).toBe("Mentoring — Arjun Rao & Priya Menon");
    expect(context.state).toBe("active");
    expect(context.origin).toBe("imported");
    expect(context.lastSessionAt).toBe("2026-09-01T09:00:00.000Z");
    expect(context.documentRef).toBe("doc_42");
    // No document binding yet — an unconfigured org is the normal case.
    expect(context.playbookUrl).toBeNull();
    expect(context.participants.map((p) => p.role)).toEqual(["mentor", "mentee"]);
  });

  it("layers the pair's agreed cadence over the program default", async () => {
    const context = await resolvers.pairContext(pairingId);
    expect(context.cadence.everyDays).toBe(21);
    // Not overridden at the pair, so the program's value survives.
    expect(context.cadence.reminderLeadHours).toBe(24);
  });

  it("uses a verified chat link and refuses an unverified one", async () => {
    const context = await resolvers.pairContext(pairingId);
    const [mentor, mentee] = context.participants;
    expect(mentor!.memberRef).toBe("U-ARJUN");
    // Falls back to an email marker rather than silently using U-PRIYA.
    expect(mentee!.memberRef).toBe("email:priya@example.com");
  });

  it("treats absent consent as not given, and revoked as not given", async () => {
    const context = await resolvers.pairContext(pairingId);
    const [mentor, mentee] = context.participants;
    expect(mentor!.consent.aiProcessing).toBe(true);
    // Granted, then revoked.
    expect(mentor!.consent.recording).toBe(false);
    // No row at all.
    expect(mentee!.consent.recording).toBe(false);
    expect(mentee!.consent.aiProcessing).toBe(true);
  });

  // `ProgramPolicySchema` defaults every field, which is what makes
  // `defaultPolicy({})` work — but it also means parsing a stored policy with
  // that same lenient schema cannot tell "unset" from "corrupted": a garbage
  // column would silently become the default program, with consent quietly
  // back to `optional`/`off`. The read path now parses through
  // `StoredProgramPolicySchema`, which requires `consent` to be stated
  // explicitly, so a policy missing it fails loudly here instead.
  it("throws rather than fill a malformed policy column with defaults", async () => {
    const brokenProgram = randomUUID();
    const brokenCohort = randomUUID();
    await handle.db
      .insert(programs)
      .values({ id: brokenProgram, orgId, name: "Broken", policy: { nonsense: true } });
    await handle.db.insert(cohorts).values({
      id: brokenCohort,
      orgId,
      programId: brokenProgram,
      name: "Broken cohort",
      startsAt: new Date("2026-07-01T00:00:00Z"),
      endsAt: new Date("2026-12-31T00:00:00Z"),
    });
    const [pair] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId: brokenCohort,
        mentorParticipantId: mentorId,
        menteeParticipantId: menteeId,
        pairKey: "broken|pair",
        state: "active",
        origin: "imported",
      })
      .returning();

    await expect(resolvers.pairContext(pair!.id)).rejects.toThrow(/stored policy is malformed/);
  });

  it("throws when a stored policy omits consent instead of defaulting it to opt_in", async () => {
    const brokenProgram = randomUUID();
    const brokenCohort = randomUUID();
    const { consent: _omitted, ...policyWithoutConsent } = policy;
    await handle.db.insert(programs).values({
      id: brokenProgram,
      orgId,
      name: "Missing consent",
      policy: policyWithoutConsent,
    });
    await handle.db.insert(cohorts).values({
      id: brokenCohort,
      orgId,
      programId: brokenProgram,
      name: "Missing consent cohort",
      startsAt: new Date("2026-07-01T00:00:00Z"),
      endsAt: new Date("2026-12-31T00:00:00Z"),
    });
    const [pair] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId: brokenCohort,
        mentorParticipantId: mentorId,
        menteeParticipantId: menteeId,
        pairKey: "missing-consent|pair",
        state: "active",
        origin: "imported",
      })
      .returning();

    await expect(resolvers.pairContext(pair!.id)).rejects.toThrow(/stored policy is malformed/);
  });

  it("throws for a pairing that does not exist", async () => {
    await expect(resolvers.pairContext(randomUUID())).rejects.toThrow(
      /unknown pairing/,
    );
  });

  it("reads an agreement back in the shape the resolver expects", async () => {
    const [row] = await handle.db
      .insert(agreements)
      .values({
        orgId,
        pairingId,
        subject: "session_time",
        options: [
          {
            optionId: "opt_1",
            startsAt: "2026-09-21T09:00:00.000Z",
            endsAt: "2026-09-21T09:45:00.000Z",
            label: "Mon",
          },
        ],
        participantIds: [mentorId, menteeId],
        responses: [
          {
            participantId: mentorId,
            kind: "accept",
            optionId: "opt_1",
            at: "2026-09-15T10:00:00.000Z",
          },
        ],
        timeoutAt: new Date("2026-09-20T09:00:00Z"),
      })
      .returning();

    const agreement = await resolvers.agreement(row!.id);
    expect(agreement).toMatchObject({
      id: row!.id,
      pairingId,
      participantIds: [mentorId, menteeId],
      round: 1,
      timeoutAt: "2026-09-20T09:00:00.000Z",
    });
    expect(agreement!.responses).toHaveLength(1);
  });

  it("returns null for an unknown agreement", async () => {
    expect(await resolvers.agreement(randomUUID())).toBeNull();
  });

  it("reads probed capabilities off the binding, not the adapter class", async () => {
    await handle.db.insert(integrationBindings).values({
      orgId,
      slot: "conferencing",
      adapterId: "google",
      // What this tenant's edition actually turned out to allow.
      capabilities: { autoTranscription: "none", createEventWithConference: true },
      probedAt: new Date(),
    });

    const caps = await resolvers.capabilities("conferencing");
    expect(caps?.autoTranscription).toBe("none");
    expect(caps?.createEventWithConference).toBe(true);
  });

  it("returns null for a slot nothing is bound to", async () => {
    expect(await resolvers.capabilities("sheet")).toBeNull();
  });

  // Declared after the other binding tests on purpose: the rows this inserts
  // are what the `playbookUrl` assertions above assume are absent.
  it("carries no playbook link when the document binding has no guideline doc", async () => {
    await handle.db.insert(integrationBindings).values({
      orgId,
      slot: "document",
      adapterId: "google-drive",
      config: { folderId: "FOLDER_1" },
      probedAt: new Date(),
    });

    expect((await resolvers.pairContext(pairingId)).playbookUrl).toBeNull();
  });

  it("turns a configured guideline doc id into the doc's own URL", async () => {
    await handle.db
      .update(integrationBindings)
      .set({ config: { folderId: "FOLDER_1", guidelineDocId: "GUIDE_1" } })
      .where(
        and(
          eq(integrationBindings.orgId, orgId),
          eq(integrationBindings.slot, "document"),
        ),
      );

    expect((await resolvers.pairContext(pairingId)).playbookUrl).toBe(
      "https://docs.google.com/document/d/GUIDE_1/edit",
    );
  });

  it("asks the calendar adapter for free/busy rather than the database", async () => {
    const busy = await resolvers.freeBusy({
      calendarRefs: ["arjun@example.com"],
      window: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" },
    });
    expect(busy).toBeDefined();
  });
});
