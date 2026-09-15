import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPolicy, subjectRef } from "@mentorship/core";
import {
  agreements,
  cohorts,
  consents,
  events,
  identityLinks,
  integrationBindings,
  organizations,
  pairings,
  participants,
  programs,
  sagaInstances,
  users,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  FakeCalendar,
  FakeConversation,
  FakeDm,
  IntegrationRegistry,
  Recorder,
} from "@mentorship/integrations";
import { PostgresEventSink } from "@mentorship/workflows/postgres";
import { createWorker, type Worker } from "../worker.js";

/**
 * The whole Postgres path in one test: a `pair.activated` row in the outbox,
 * and a saga that proposes times because a worker picked it up. Store, relay,
 * resolvers and sink were each proved separately; this is the one that fails
 * if they do not fit together.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

describe.skipIf(!DATABASE_URL)("the worker, end to end on Postgres", () => {
  let handle: TestDb;
  let worker: Worker;
  let recorder: Recorder;
  let sink: PostgresEventSink;
  const orgId = randomUUID();
  const programId = randomUUID();
  const cohortId = randomUUID();
  const mentorUser = randomUUID();
  const menteeUser = randomUUID();
  let pairingId: string;

  // A Monday, so the proposer has working hours to offer inside its window.
  const now = new Date("2026-09-14T06:00:00.000Z");

  beforeAll(async () => {
    handle = await connectTestDb();
    recorder = new Recorder();
    const registry = new IntegrationRegistry();
    registry.bind(new FakeConversation(recorder));
    registry.bind(new FakeDm(recorder));
    registry.bind(new FakeCalendar(recorder, {}));

    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Worker", slug: `worker-${orgId.slice(0, 8)}` });
    await handle.db.insert(programs).values({
      id: programId,
      orgId,
      name: "Career Mentoring",
      policy: defaultPolicy({
        pairing: { mode: "imported" },
        cadence: { everyDays: 14, label: "fortnightly", reminderLeadHours: 24 },
      }),
    });
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
    await handle.db.insert(identityLinks).values([
      {
        orgId,
        userId: mentorUser,
        provider: "slack",
        externalId: "U-ARJUN",
        verifiedAt: now,
      },
      {
        orgId,
        userId: menteeUser,
        provider: "slack",
        externalId: "U-PRIYA",
        verifiedAt: now,
      },
    ]);
    const [pair] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId,
        mentorParticipantId: people[0]!.id,
        menteeParticipantId: people[1]!.id,
        pairKey: "arjun|priya",
        state: "active",
        origin: "imported",
      })
      .returning();
    pairingId = pair!.id;

    sink = new PostgresEventSink(handle.db, { now: () => now });
    worker = createWorker({
      db: handle.db,
      orgId,
      registry,
      now: () => now,
    });
  });

  afterAll(async () => {
    if (!handle) return;
    for (const table of [
      sagaInstances,
      events,
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

  it("starts a saga from an outbox event and proposes times", async () => {
    // Exactly what the roster importer writes when a pair goes active — the
    // worker cannot tell an imported pair from a matched one, which is the
    // point of ADR-0003.
    await sink.emit({
      orgId,
      name: "pair.activated",
      subjectRef: subjectRef("pairing", pairingId),
      payload: { participantIds: [] },
    });

    // A pass keeps claiming until the outbox is empty, so this delivers the
    // activation *and* the events the saga emits in response to it.
    const { relay } = await worker.pass();
    expect(relay.delivered).toBeGreaterThanOrEqual(1);
    expect(relay.failed).toBe(0);
    expect(relay.deadLettered).toBe(0);

    const instances = await handle.db
      .select()
      .from(sagaInstances)
      .where(eq(sagaInstances.orgId, orgId));
    expect(instances).toHaveLength(1);
    expect((instances[0]!.state as { name: string }).name).toBe("proposing");

    // The effects actually ran: a thread exists and a proposal was posted to it.
    const kinds = recorder.calls.map((c) => c.kind);
    expect(kinds).toContain("thread.created");
    expect(kinds).toContain("thread.proposal");
  });

  it("wrote the saga's own events back to the outbox for the next pass", async () => {
    const rows = await handle.db
      .select()
      .from(events)
      .where(eq(events.orgId, orgId));
    const names = rows.map((r) => r.name);
    expect(names).toContain("agreement.opened");
    expect(names).toContain("session.proposed");

    // A pass keeps claiming until the outbox is empty, so the events the saga
    // produced mid-pass were picked up by the same pass rather than the next.
    expect(rows.every((r) => r.relayedAt !== null)).toBe(true);
  });

  it("advances the saga when both parties accept, through the outbox", async () => {
    // Drain what the first pass produced, so the agreement is on record.
    await worker.pass();

    const [agreement] = await handle.db
      .select()
      .from(agreements)
      .where(eq(agreements.orgId, orgId));
    expect(agreement).toBeDefined();

    const parties = agreement!.participantIds as string[];
    const options = agreement!.options as { optionId: string }[];
    const chosen = options[0]!.optionId;

    // Both accept — the same rows the Slack endpoint writes.
    await handle.db
      .update(agreements)
      .set({
        responses: parties.map((participantId) => ({
          participantId,
          kind: "accept",
          optionId: chosen,
          at: now.toISOString(),
        })),
      })
      .where(eq(agreements.id, agreement!.id));

    for (const participantId of parties) {
      await sink.emit({
        orgId,
        name: "agreement.responded",
        subjectRef: subjectRef("agreement", agreement!.id),
        payload: { agreementId: agreement!.id, participantId, kind: "accept" },
      });
    }

    // Two passes: one delivers the responses and books, the next drains the
    // session.scheduled the booking produced.
    await worker.pass();
    await worker.pass();

    const [instance] = await handle.db
      .select()
      .from(sagaInstances)
      .where(eq(sagaInstances.orgId, orgId));
    expect((instance!.state as { name: string }).name).toBe("armed");
    expect(recorder.calls.map((c) => c.kind)).toContain("calendar.created");

    // And the history is there to answer "why is this pair where it is".
    const history = instance!.history as { to: string }[];
    expect(history.map((h) => h.to)).toEqual([
      "proposing",
      "scheduling",
      "armed",
    ]);
  });

  it("leaves nothing pending once the outbox is drained", async () => {
    let guard = 0;
    while (guard++ < 10) {
      const { relay, timers } = await worker.pass();
      if (relay.delivered === 0 && timers === 0) break;
    }
    const rows = await handle.db
      .select()
      .from(events)
      .where(eq(events.orgId, orgId));
    expect(rows.every((r) => r.relayedAt !== null)).toBe(true);
    expect(rows.every((r) => r.deadLetteredAt === null)).toBe(true);
  });
});
