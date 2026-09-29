import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MagicLinkStore } from "@mentorship/auth";
import { defaultPolicy, type StaffRole } from "@mentorship/core";
import { FakeStaffDirectory } from "./staff-fake.js";
import {
  parsePreferenceEvents,
  programDefaultCadence,
  shapePairPreferenceChanges,
  type PairPreferenceChanges,
} from "../pair-preference-changes.js";
import {
  createServer,
  notImplementedMatchingReads,
  notImplementedPairPreferenceReads,
  notImplementedReads,
  type PairPreferenceChangesQuery,
} from "../server.js";

/**
 * ADR-0009 action 7: the admin view of pairs changing their own length and
 * rhythm. The shaping half is pure (validation, names, the program default
 * and the drift flag); the route half is the same staff gate every list
 * route has. The Postgres half — a real change through the store, RLS — is
 * `postgres-pair-preference-changes.test.ts`.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const PAIRING = "aaaaaaaa-0000-4000-8000-000000000001";
const MENTOR = "bbbbbbbb-0000-4000-8000-000000000001";
const MENTEE = "bbbbbbbb-0000-4000-8000-000000000002";
const COHORT = "cccccccc-0000-4000-8000-000000000001";

const payload = (over: Record<string, unknown> = {}) => ({
  pairingId: PAIRING,
  participantId: MENTEE,
  sessionMinutes: 30,
  everyDays: 14,
  changed: { sessionMinutes: 30 },
  ...over,
});

describe("parsePreferenceEvents", () => {
  it("keeps valid payloads and counts, rather than throws on, malformed ones", () => {
    const at = new Date("2026-09-20T10:00:00.000Z");
    const { valid, skipped } = parsePreferenceEvents([
      { id: "e1", occurredAt: at, payload: payload() },
      { id: "e2", occurredAt: at, payload: { pairingId: "not-a-uuid" } },
      { id: "e3", occurredAt: at, payload: payload({ changed: {} }) },
      { id: "e4", occurredAt: at, payload: null },
      { id: "e5", occurredAt: at, payload: payload({ sessionMinutes: 5 }) },
    ]);
    expect(valid.map((v) => v.id)).toEqual(["e1"]);
    expect(skipped).toBe(4);
  });
});

describe("programDefaultCadence", () => {
  it("is program policy then cohort override, never the pair's own", () => {
    expect(programDefaultCadence({ policy: defaultPolicy(), cadenceOverride: null })).toEqual({
      sessionMinutes: 45,
      everyDays: 14,
    });
    expect(
      programDefaultCadence({ policy: defaultPolicy(), cadenceOverride: { everyDays: 7 } }),
    ).toEqual({ sessionMinutes: 45, everyDays: 7 });
  });

  it("is null for a policy the pair-preferences store itself could not resolve", () => {
    expect(programDefaultCadence({ policy: {}, cadenceOverride: null })).toBeNull();
    expect(
      programDefaultCadence({ policy: defaultPolicy(), cadenceOverride: { everyDays: -3 } }),
    ).toBeNull();
  });
});

describe("shapePairPreferenceChanges", () => {
  const lookups = {
    pairings: new Map([
      [PAIRING, { cohortId: COHORT, mentorParticipantId: MENTOR, menteeParticipantId: MENTEE }],
    ]),
    names: new Map([
      [MENTOR, "Arjun"],
      [MENTEE, "Priya"],
    ]),
    cohorts: new Map([[COHORT, { policy: defaultPolicy(), cadenceOverride: null }]]),
  };
  const at = new Date("2026-09-20T10:00:00.000Z");

  it("names the pair and who changed it, and flags a drift from the program default", () => {
    const [row] = shapePairPreferenceChanges(
      parsePreferenceEvents([{ id: "e1", occurredAt: at, payload: payload() }]).valid,
      lookups,
    );
    expect(row).toEqual({
      eventId: "e1",
      occurredAt: "2026-09-20T10:00:00.000Z",
      pairingId: PAIRING,
      mentorName: "Arjun",
      menteeName: "Priya",
      changedBy: { participantId: MENTEE, displayName: "Priya" },
      changed: { sessionMinutes: 30 },
      result: { sessionMinutes: 30, everyDays: 14 },
      programDefault: { sessionMinutes: 45, everyDays: 14 },
      differsFromProgramDefault: true,
    });
  });

  it("does not flag a pair that chose its way back to the program default", () => {
    const [row] = shapePairPreferenceChanges(
      parsePreferenceEvents([
        {
          id: "e1",
          occurredAt: at,
          payload: payload({ sessionMinutes: 45, changed: { sessionMinutes: 45 } }),
        },
      ]).valid,
      lookups,
    );
    expect(row!.differsFromProgramDefault).toBe(false);
  });

  it("keeps a row whose pairing no longer resolves, with nulls rather than guesses", () => {
    const [row] = shapePairPreferenceChanges(
      parsePreferenceEvents([
        { id: "e1", occurredAt: at, payload: payload({ pairingId: COHORT }) },
      ]).valid,
      lookups,
    );
    expect(row).toMatchObject({
      mentorName: null,
      menteeName: null,
      changedBy: { displayName: "Priya" },
      programDefault: null,
      differsFromProgramDefault: false,
    });
  });
});

class FakeMagicLinkStore implements MagicLinkStore {
  sessions = new Map<string, { orgId: string; userId: string }>();
  private next = 1;
  seedSession(orgId: string, userId: string): string {
    const id = `sess-${this.next++}`;
    this.sessions.set(id, { orgId, userId });
    return id;
  }
  async findUserByEmail() {
    return null;
  }
  async createLink(): Promise<void> {}
  async findUnconsumedLinkByTokenHash() {
    return null;
  }
  async consumeLink(): Promise<boolean> {
    return false;
  }
  async createSession(input: { orgId: string; userId: string }) {
    return { sessionId: this.seedSession(input.orgId, input.userId) };
  }
  async findActiveSession(orgId: string, sessionId: string) {
    const row = this.sessions.get(sessionId);
    if (!row || row.orgId !== orgId) return null;
    return {
      userId: row.userId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    };
  }
}

describe("GET /orgs/:orgId/pair-preference-changes", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(query: PairPreferenceChangesQuery) {
    const store = new FakeMagicLinkStore();
    const staff = new FakeStaffDirectory(null);
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: { resolveParticipantId: async () => null },
      responder: { respond: async () => {} },
      admin: {
        riskFindings: notImplementedReads(),
        nudges: notImplementedReads(),
        stuckSagas: notImplementedReads(),
        deadLetters: notImplementedReads(),
        matchingRoundCandidates: notImplementedMatchingReads(),
        pairPreferenceChanges: query,
      },
      auth: { store, staff, orgId: ORG },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    const get = (path: string, as?: { userId: string; role: StaffRole | null }) => {
      let cookie: string | undefined;
      if (as) {
        staff.set(ORG, as.userId, as.role);
        cookie = `mentorship_session=${store.seedSession(ORG, as.userId)}`;
      }
      return fetch(`http://127.0.0.1:${port}${path}`, {
        headers: cookie ? { cookie } : {},
      });
    };
    return { get };
  }

  const body: PairPreferenceChanges = { changes: [], skipped: 2 };

  it("401s without a session and 403s a signed-in non-staff user, never reaching the query", async () => {
    let calls = 0;
    const { get } = await listen(async () => {
      calls++;
      return body;
    });
    expect((await get(`/orgs/${ORG}/pair-preference-changes`)).status).toBe(401);
    const res = await get(`/orgs/${ORG}/pair-preference-changes`, {
      userId: "user-mentee",
      role: null,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(calls).toBe(0);
  });

  it("serves admin and program_lead alike — activity, not sentiment — passing a clamped limit", async () => {
    const limits: number[] = [];
    const { get } = await listen(async (orgId, limit) => {
      expect(orgId).toBe(ORG);
      limits.push(limit);
      return body;
    });
    for (const role of ["admin", "program_lead"] as const) {
      const res = await get(`/orgs/${ORG}/pair-preference-changes?limit=5000`, {
        userId: `user-${role}`,
        role,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(body);
    }
    expect((await get(`/orgs/${ORG}/pair-preference-changes`, { userId: "u", role: "admin" })).status).toBe(200);
    expect(limits).toEqual([200, 200, 50]);
  });

  it("501s on the in-memory backend", async () => {
    const { get } = await listen(notImplementedPairPreferenceReads());
    const res = await get(`/orgs/${ORG}/pair-preference-changes`, {
      userId: "user-admin",
      role: "admin",
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/pair-preference-changes/);
  });
});
