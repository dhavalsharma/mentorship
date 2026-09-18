import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultPolicy,
  resolveAgreement,
  type Agreement,
  type AgreementResponse,
} from "@mentorship/core";
import {
  agreements,
  cohorts,
  events,
  identityLinks,
  organizations,
  pairings,
  participants,
  programs,
  users,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  handleSlackInteraction,
  type SlackTransport,
} from "@mentorship/integrations";
import { SlackWebApiModalOpener } from "@mentorship/integrations";
import {
  PostgresAgreementResponder,
  PostgresChatIdentityResolver,
  PostgresCounterContextResolver,
} from "../postgres-ports.js";

/**
 * "Suggest another" against a real database: the click opens a view with the
 * agreement in its `private_metadata`, and the submission writes a `counter`
 * response the deterministic resolver then reads as `countered` — the first
 * time anything in this repo populates `AgreementResponse.counter` for real.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

const SECRET = "shh-its-a-secret";
const NOW = new Date("2026-09-15T04:30:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function signedHeaders(rawBody: string): Record<string, string> {
  const base = `v0:${TS}:${rawBody}`;
  return {
    "x-slack-request-timestamp": TS,
    "x-slack-signature":
      "v0=" + createHmac("sha256", SECRET).update(base).digest("hex"),
  };
}

const formEncoded = (payload: unknown): string =>
  `payload=${encodeURIComponent(JSON.stringify(payload))}`;

describe.skipIf(!DATABASE_URL)("the counter-proposal modal on Postgres", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const programId = randomUUID();
  const cohortId = randomUUID();
  const mentorUserId = randomUUID();
  const menteeUserId = randomUUID();
  let mentorParticipantId: string;
  let menteeParticipantId: string;
  let pairingId: string;
  let agreementId: string;

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Counter", slug: `counter-${orgId.slice(0, 8)}` });
    await handle.db.insert(programs).values({
      id: programId,
      orgId,
      name: "Mentoring",
      // 45-minute sessions by default — what the counter's end time is derived
      // from, read through the same program -> cohort -> pair chain the saga
      // resolver uses.
      policy: defaultPolicy(),
    });
    await handle.db.insert(cohorts).values({
      id: cohortId,
      orgId,
      programId,
      name: "2026 H2",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-12-31T00:00:00.000Z"),
    });
    await handle.db.insert(users).values([
      {
        id: mentorUserId,
        orgId,
        email: "arjun@example.com",
        displayName: "Arjun",
        tzOffsetMinutes: 330,
      },
      {
        id: menteeUserId,
        orgId,
        email: "priya@example.com",
        displayName: "Priya",
        tzOffsetMinutes: 330,
      },
    ]);
    const inserted = await handle.db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUserId, role: "mentor" },
        { orgId, cohortId, userId: menteeUserId, role: "mentee" },
      ])
      .returning();
    mentorParticipantId = inserted[0]!.id;
    menteeParticipantId = inserted[1]!.id;

    await handle.db.insert(identityLinks).values({
      orgId,
      userId: mentorUserId,
      provider: "slack",
      externalId: "U-ARJUN",
      verifiedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const [pairing] = await handle.db
      .insert(pairings)
      .values({
        orgId,
        cohortId,
        mentorParticipantId,
        menteeParticipantId,
        state: "active",
        origin: "imported",
        pairKey: `${mentorUserId}:${menteeUserId}`,
      })
      .returning();
    pairingId = pairing!.id;

    const [agreement] = await handle.db
      .insert(agreements)
      .values({
        orgId,
        pairingId,
        subject: "session_time",
        options: [
          {
            optionId: "opt_1",
            startsAt: "2026-09-16T09:00:00.000Z",
            endsAt: "2026-09-16T09:45:00.000Z",
            label: "Wed 16 Sept 14:30 (UTC+05:30)",
          },
        ],
        participantIds: [mentorParticipantId, menteeParticipantId],
        responses: [],
        timeoutAt: new Date("2026-09-17T04:30:00.000Z"),
      })
      .returning();
    agreementId = agreement!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(events).where(eq(events.orgId, orgId));
    await handle.db.delete(agreements).where(eq(agreements.orgId, orgId));
    await handle.db.delete(pairings).where(eq(pairings.orgId, orgId));
    await handle.db.delete(identityLinks).where(eq(identityLinks.orgId, orgId));
    await handle.db.delete(participants).where(eq(participants.orgId, orgId));
    await handle.db.delete(users).where(eq(users.orgId, orgId));
    await handle.db.delete(cohorts).where(eq(cohorts.orgId, orgId));
    await handle.db.delete(programs).where(eq(programs.orgId, orgId));
    await handle.db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await handle.close();
  });

  const deps = (call: SlackTransport) => ({
    signingSecret: SECRET,
    identity: new PostgresChatIdentityResolver({ db: handle.db, orgId }),
    responder: new PostgresAgreementResponder({ db: handle.db, orgId }),
    modals: new SlackWebApiModalOpener(call),
    counters: new PostgresCounterContextResolver({
      db: handle.db,
      orgId,
      now: () => NOW,
    }),
    now: () => NOW,
  });

  it("opens a view carrying the agreement id, using the click's trigger_id", async () => {
    const call = vi.fn<SlackTransport>(async () => ({ ok: true }));
    const body = formEncoded({
      type: "block_actions",
      user: { id: "U-ARJUN" },
      trigger_id: "trg-987.654",
      actions: [
        {
          action_id: `counter:${agreementId}`,
          value: JSON.stringify({ agreementId, kind: "counter" }),
        },
      ],
    });

    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      deps(call),
    );
    expect(res.status).toBe(200);

    const [method, sent] = call.mock.calls[0]!;
    expect(method).toBe("views.open");
    expect(sent["trigger_id"]).toBe("trg-987.654");
    const view = sent["view"] as { private_metadata: string };
    expect(JSON.parse(view.private_metadata)).toEqual({ agreementId });

    // Opening a view writes nothing.
    const rows = await handle.db
      .select()
      .from(events)
      .where(eq(events.orgId, orgId));
    expect(rows).toEqual([]);
  });

  it("records the submitted date and time as a counter the resolver reads as `countered`", async () => {
    const call = vi.fn<SlackTransport>(async () => ({ ok: true }));
    const body = formEncoded({
      type: "view_submission",
      user: { id: "U-ARJUN" },
      view: {
        callback_id: "counter_proposal",
        private_metadata: JSON.stringify({ agreementId }),
        state: {
          values: {
            counter_date: {
              counter_date_value: {
                type: "datepicker",
                selected_date: "2026-09-18",
              },
            },
            counter_time: {
              counter_time_value: {
                type: "timepicker",
                selected_time: "16:00",
              },
            },
          },
        },
      },
    });

    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      deps(call),
    );
    // Empty 200 closes the modal; no Slack call is made from the submission.
    expect(res.status).toBe(200);
    expect(res.body ?? "").toBe("");
    expect(call).not.toHaveBeenCalled();

    const [row] = await handle.db
      .select()
      .from(agreements)
      .where(eq(agreements.id, agreementId));
    const stored: Agreement = {
      id: row!.id,
      subject: "session_time",
      pairingId: row!.pairingId,
      participantIds: row!.participantIds as string[],
      options: row!.options as Agreement["options"],
      responses: row!.responses as AgreementResponse[],
      round: row!.round,
      openedAt: row!.createdAt.toISOString(),
      timeoutAt: row!.timeoutAt.toISOString(),
    };

    const resolution = resolveAgreement(
      stored,
      defaultPolicy().agreement,
      NOW,
    );
    expect(resolution).toMatchObject({
      status: "countered",
      by: mentorParticipantId,
      // 16:00 at +05:30 is 10:30 UTC; a 45-minute session ends at 11:15.
      counter: expect.objectContaining({
        startsAt: "2026-09-18T10:30:00.000Z",
        endsAt: "2026-09-18T11:15:00.000Z",
      }),
    });

    // And the outbox carries the same fact for the relay to hand the saga.
    const [outbox] = await handle.db
      .select()
      .from(events)
      .where(eq(events.orgId, orgId));
    expect(outbox!.name).toBe("agreement.responded");
    expect(outbox!.payload).toMatchObject({ agreementId, kind: "counter" });
  });

  it("refuses a submission from someone who is not a party to the agreement", async () => {
    const stranger = randomUUID();
    const context = await new PostgresCounterContextResolver({
      db: handle.db,
      orgId,
      now: () => NOW,
    }).resolve({ agreementId, participantId: stranger });
    expect(context).toBeNull();
  });

  it("refuses a counter to an agreement whose window has closed", async () => {
    const context = await new PostgresCounterContextResolver({
      db: handle.db,
      orgId,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    }).resolve({ agreementId, participantId: mentorParticipantId });
    expect(context).toBeNull();
  });
});
