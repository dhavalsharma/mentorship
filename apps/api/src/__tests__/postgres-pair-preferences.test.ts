import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultPolicy, resolveCadence, type Cadence } from "@mentorship/core";
import {
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
  SlackWebApiModalOpener,
  type SlackTransport,
} from "@mentorship/integrations";
import {
  PostgresChatIdentityResolver,
  PostgresPairPreferencesStore,
} from "../postgres-ports.js";

/**
 * "Session preferences" against a real database: the click opens a modal
 * pre-filled from the resolved cadence, and the submission writes the pair's
 * `cadence_override` and its `pair.preferences_updated` outbox row in one
 * transaction — merged onto what roster import already put there, never
 * replacing it wholesale.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

const SECRET = "shh-its-a-secret";
const NOW = new Date("2026-09-15T04:30:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function signedHeaders(rawBody: string): Record<string, string> {
  return {
    "x-slack-request-timestamp": TS,
    "x-slack-signature":
      "v0=" +
      createHmac("sha256", SECRET).update(`v0:${TS}:${rawBody}`).digest("hex"),
  };
}

const formEncoded = (payload: unknown): string =>
  `payload=${encodeURIComponent(JSON.stringify(payload))}`;

describe.skipIf(!DATABASE_URL)("pair session preferences on Postgres", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const programId = randomUUID();
  const cohortId = randomUUID();
  const mentorUserId = randomUUID();
  const menteeUserId = randomUUID();
  const strangerUserId = randomUUID();
  let mentorParticipantId: string;
  let strangerParticipantId: string;
  let pairingId: string;

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Prefs", slug: `prefs-${orgId.slice(0, 8)}` });
    await handle.db
      .insert(programs)
      .values({ id: programId, orgId, name: "Mentoring", policy: defaultPolicy() });
    await handle.db.insert(cohorts).values({
      id: cohortId,
      orgId,
      programId,
      name: "2026 H2",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-12-31T00:00:00.000Z"),
    });
    await handle.db.insert(users).values([
      { id: mentorUserId, orgId, email: "arjun@example.com", displayName: "Arjun", tzOffsetMinutes: 330 },
      { id: menteeUserId, orgId, email: "priya@example.com", displayName: "Priya", tzOffsetMinutes: 330 },
      { id: strangerUserId, orgId, email: "sam@example.com", displayName: "Sam", tzOffsetMinutes: 0 },
    ]);
    const inserted = await handle.db
      .insert(participants)
      .values([
        { orgId, cohortId, userId: mentorUserId, role: "mentor" },
        { orgId, cohortId, userId: menteeUserId, role: "mentee" },
        { orgId, cohortId, userId: strangerUserId, role: "mentee" },
      ])
      .returning();
    mentorParticipantId = inserted[0]!.id;
    strangerParticipantId = inserted[2]!.id;

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
        menteeParticipantId: inserted[1]!.id,
        state: "active",
        origin: "imported",
        pairKey: `${mentorUserId}:${menteeUserId}`,
        // What roster import writes for a "monthly" row — the pair changing
        // only its length must keep this rhythm.
        cadenceOverride: { everyDays: 30, label: "monthly" },
      })
      .returning();
    pairingId = pairing!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(events).where(eq(events.orgId, orgId));
    await handle.db.delete(pairings).where(eq(pairings.orgId, orgId));
    await handle.db.delete(identityLinks).where(eq(identityLinks.orgId, orgId));
    await handle.db.delete(participants).where(eq(participants.orgId, orgId));
    await handle.db.delete(users).where(eq(users.orgId, orgId));
    await handle.db.delete(cohorts).where(eq(cohorts.orgId, orgId));
    await handle.db.delete(programs).where(eq(programs.orgId, orgId));
    await handle.db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await handle.close();
  });

  const store = () =>
    new PostgresPairPreferencesStore({ db: handle.db, orgId, now: () => NOW });

  it("reads the resolved cadence and the program's menu for a pair member", async () => {
    expect(
      await store().context({ pairingId, participantId: mentorParticipantId }),
    ).toEqual({
      sessionMinutes: 45,
      everyDays: 30,
      policy: defaultPolicy().pairPreferences,
    });
  });

  it("refuses someone who is not in the pair", async () => {
    expect(
      await store().context({ pairingId, participantId: strangerParticipantId }),
    ).toBeNull();
    expect(
      await store().update({
        pairingId,
        participantId: strangerParticipantId,
        preferences: { everyDays: 7 },
      }),
    ).toEqual({ ok: false, reason: "not_member" });
  });

  it("opens the modal off a real click, pre-selecting Custom for the imported monthly rhythm", async () => {
    const call = vi.fn<SlackTransport>(async () => ({ ok: true }));
    const body = formEncoded({
      type: "block_actions",
      user: { id: "U-ARJUN" },
      trigger_id: "trg-1",
      actions: [
        {
          action_id: `preferences:${pairingId}`,
          value: JSON.stringify({ pairingId, kind: "preferences" }),
        },
      ],
    });
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      {
        signingSecret: SECRET,
        identity: new PostgresChatIdentityResolver({ db: handle.db, orgId }),
        responder: { respond: vi.fn(async () => {}) },
        preferences: { modals: new SlackWebApiModalOpener(call), store: store() },
        now: () => NOW,
      },
    );
    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledOnce();
    const [method, payload] = call.mock.calls[0]!;
    expect(method).toBe("views.open");
    const view = payload["view"] as { blocks: { block_id?: string; element?: Record<string, unknown> }[] };
    const cadence = view.blocks.find((b) => b.block_id === "pref_cadence")!;
    expect((cadence.element!["initial_option"] as { value: string }).value).toBe("custom");
  });

  it("merges the change onto the existing override and writes the outbox event with it", async () => {
    const saved = await store().update({
      pairingId,
      participantId: mentorParticipantId,
      preferences: { sessionMinutes: 30 },
    });
    expect(saved).toEqual({ ok: true, sessionMinutes: 30, everyDays: 30 });

    const [row] = await handle.db
      .select({ cadenceOverride: pairings.cadenceOverride })
      .from(pairings)
      .where(eq(pairings.id, pairingId));
    expect(row!.cadenceOverride).toEqual({
      everyDays: 30,
      label: "monthly",
      sessionMinutes: 30,
    });
    // And every reader resolving through the normal chain now sees it.
    expect(
      resolveCadence(
        defaultPolicy().cadence,
        null,
        row!.cadenceOverride as Partial<Cadence>,
      ).sessionMinutes,
    ).toBe(30);

    const written = await handle.db
      .select()
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.name, "pair.preferences_updated")));
    expect(written).toHaveLength(1);
    expect(written[0]!.subjectRef).toBe(`pairing:${pairingId}`);
    expect(written[0]!.payload).toMatchObject({
      pairingId,
      participantId: mentorParticipantId,
      sessionMinutes: 30,
      everyDays: 30,
      changed: { sessionMinutes: 30 },
    });
  });

  it("saves a real modal submission end to end", async () => {
    const body = formEncoded({
      type: "view_submission",
      user: { id: "U-ARJUN" },
      view: {
        callback_id: "pair_preferences",
        private_metadata: JSON.stringify({ pairingId }),
        state: {
          values: {
            pref_session: { pref_session_value: { selected_option: { value: "15" } } },
            pref_cadence: { pref_cadence_value: { selected_option: { value: "custom" } } },
            pref_cadence_custom: { pref_cadence_custom_value: { value: "10" } },
          },
        },
      },
    });
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      {
        signingSecret: SECRET,
        identity: new PostgresChatIdentityResolver({ db: handle.db, orgId }),
        responder: { respond: vi.fn(async () => {}) },
        preferences: {
          modals: new SlackWebApiModalOpener(async () => ({ ok: true })),
          store: store(),
        },
        now: () => NOW,
      },
    );
    expect(JSON.parse(res.body!).response_action).toBe("update");
    const [row] = await handle.db
      .select({ cadenceOverride: pairings.cadenceOverride })
      .from(pairings)
      .where(eq(pairings.id, pairingId));
    expect(row!.cadenceOverride).toEqual({
      everyDays: 10,
      label: "every 10 days",
      sessionMinutes: 15,
    });
  });

  it("refuses with reason 'disabled' — and writes nothing — once the program turns choice off", async () => {
    const before = await handle.db
      .select({ cadenceOverride: pairings.cadenceOverride })
      .from(pairings)
      .where(eq(pairings.id, pairingId));
    await handle.db
      .update(programs)
      .set({ policy: defaultPolicy({ pairPreferences: { enabled: false } }) })
      .where(eq(programs.id, programId));
    try {
      expect(
        await store().update({
          pairingId,
          participantId: mentorParticipantId,
          preferences: { everyDays: 7 },
        }),
      ).toEqual({ ok: false, reason: "disabled" });
      const after = await handle.db
        .select({ cadenceOverride: pairings.cadenceOverride })
        .from(pairings)
        .where(eq(pairings.id, pairingId));
      expect(after[0]!.cadenceOverride).toEqual(before[0]!.cadenceOverride);
    } finally {
      await handle.db
        .update(programs)
        .set({ policy: defaultPolicy() })
        .where(eq(programs.id, programId));
    }
  });
});
