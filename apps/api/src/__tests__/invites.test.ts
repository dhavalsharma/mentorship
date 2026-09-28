import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MagicLinkStore } from "@mentorship/auth";
import type { InvitePlan } from "@mentorship/enrollment";
import {
  createServer,
  type ApiServerDeps,
  type EnrollmentService,
  type InviteOutcome,
} from "../server.js";

/**
 * `POST /orgs/:orgId/invites` and the accept-on-sign-in step of
 * `/auth/verify`, over a real socket with fakes behind the ports. The
 * Postgres half — RLS, the dedupe on real rows, the audit row — is
 * `postgres-enrollment.test.ts`.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const COHORT = "33333333-3333-3333-3333-333333333333";

/** Knows users by email, keeps links and sessions in memory. */
class FakeMagicLinkStore implements MagicLinkStore {
  users = new Map<string, string>(); // email -> userId
  links = new Map<string, { userId: string; expiresAt: string; consumedAt: string | null }>();
  sessions = new Map<string, { orgId: string; userId: string }>();
  private next = 1;

  seedSession(orgId: string, userId: string): string {
    const id = `sess-${this.next++}`;
    this.sessions.set(id, { orgId, userId });
    return id;
  }

  async findUserByEmail(_orgId: string, email: string) {
    const userId = this.users.get(email);
    return userId ? { userId } : null;
  }
  async createLink(input: { userId: string; tokenHash: string; expiresAt: string }) {
    this.links.set(input.tokenHash, {
      userId: input.userId,
      expiresAt: input.expiresAt,
      consumedAt: null,
    });
  }
  async findUnconsumedLinkByTokenHash(_orgId: string, tokenHash: string) {
    return this.links.get(tokenHash) ?? null;
  }
  async consumeLink(_orgId: string, tokenHash: string) {
    const link = this.links.get(tokenHash);
    if (!link || link.consumedAt) return false;
    link.consumedAt = new Date().toISOString();
    return true;
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

/**
 * Mirrors what the Postgres service does closely enough to exercise the
 * route: one known cohort whose program has mentor/mentee, dedupe on
 * email+cohort+role, and — because an invite creates a user — it registers
 * the invitee with the magic-link store so a link can be issued.
 */
class FakeEnrollment implements EnrollmentService {
  invites = new Map<string, { participantId: string; userId: string; state: string }>();
  calls: { orgId: string; plan: InvitePlan; actor: string }[] = [];
  accepted: { orgId: string; userId: string }[] = [];
  failAccept = false;

  constructor(private readonly links: FakeMagicLinkStore) {}

  async invite(orgId: string, plan: InvitePlan, actor: string): Promise<InviteOutcome> {
    this.calls.push({ orgId, plan, actor });
    if (plan.cohortId !== COHORT) return { ok: false, reason: "unknown_cohort" };
    if (!["mentor", "mentee"].includes(plan.role)) {
      return { ok: false, reason: "unknown_role", roles: ["mentor", "mentee"] };
    }
    const key = `${plan.email}|${plan.cohortId}|${plan.role}`;
    const existing = this.invites.get(key);
    if (existing) return { ok: true, alreadyInvited: true, ...existing };
    const userId = this.links.users.get(plan.email) ?? `user-${this.links.users.size + 1}`;
    this.links.users.set(plan.email, userId);
    const row = { participantId: `p-${this.invites.size + 1}`, userId, state: "invited" };
    this.invites.set(key, row);
    return { ok: true, alreadyInvited: false, ...row };
  }

  async acceptPendingInvites(orgId: string, userId: string) {
    if (this.failAccept) throw new Error("db down");
    this.accepted.push({ orgId, userId });
    const ids: string[] = [];
    for (const row of this.invites.values()) {
      if (row.userId === userId && row.state === "invited") {
        row.state = "enrolled";
        ids.push(row.participantId);
      }
    }
    return { accepted: ids };
  }
}

describe("POST /orgs/:orgId/invites", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(overrides: Partial<ApiServerDeps> = {}, withEnrollment = true) {
    const store = new FakeMagicLinkStore();
    const enrollment = new FakeEnrollment(store);
    const issued: { email: string; token: string }[] = [];
    const unhandled: string[] = [];
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: { resolveParticipantId: async () => null },
      responder: { respond: async () => {} },
      auth: {
        store,
        orgId: ORG,
        onMagicLinkIssued: (email, token) => issued.push({ email, token }),
      },
      ...(withEnrollment ? { enrollment } : {}),
      onUnhandled: (reason) => unhandled.push(reason),
      ...overrides,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const cookie = `mentorship_session=${store.seedSession(ORG, "admin-1")}`;
    const post = (body: unknown, opts: { org?: string; cookie?: string | null } = {}) =>
      fetch(`${base}/orgs/${opts.org ?? ORG}/invites`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? cookie }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    return { base, store, enrollment, issued, unhandled, post };
  }

  const valid = { email: "Ada@Example.com", cohortId: COHORT, role: "mentee" };

  it("401s without a session, before reading the body", async () => {
    const { post, enrollment } = await listen();
    const res = await post(valid, { cookie: null });
    expect(res.status).toBe(401);
    expect(enrollment.calls).toHaveLength(0);
  });

  it("403s a session for this org naming another org", async () => {
    const { post, enrollment } = await listen();
    const res = await post(valid, { org: OTHER_ORG });
    expect(res.status).toBe(403);
    expect(enrollment.calls).toHaveLength(0);
  });

  it("creates an invite: 201, normalised email, admin as actor, a sign-in link issued but never returned", async () => {
    const { post, enrollment, issued } = await listen();
    const res = await post(valid);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      participantId: "p-1",
      alreadyInvited: false,
      state: "invited",
      signInLinkIssued: true,
    });
    expect(enrollment.calls[0]).toMatchObject({
      orgId: ORG,
      actor: "admin-1",
      plan: {
        email: "ada@example.com",
        displayName: "Ada",
        tzOffsetMinutes: 0,
        cohortId: COHORT,
        role: "mentee",
        orgId: ORG,
      },
    });
    expect(issued).toHaveLength(1);
    expect(issued[0]!.email).toBe("ada@example.com");
    expect(JSON.stringify(body)).not.toContain(issued[0]!.token);
  });

  it("dedupes a repeat invite: 200, same participant, and re-issues the link while still invited", async () => {
    const { post, issued } = await listen();
    await post(valid);
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      participantId: "p-1",
      alreadyInvited: true,
      state: "invited",
      signInLinkIssued: true,
    });
    expect(issued).toHaveLength(2);
  });

  it("issues no link for a repeat invite of someone already enrolled", async () => {
    const { post, issued, enrollment } = await listen();
    await post(valid);
    for (const row of enrollment.invites.values()) row.state = "enrolled";
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "enrolled", signInLinkIssued: false });
    expect(issued).toHaveLength(1);
  });

  it("passes optional fields through", async () => {
    const { post, enrollment } = await listen();
    await post({ ...valid, displayName: "Ada Lovelace", tzOffsetMinutes: 60, capacity: 2 });
    expect(enrollment.calls[0]!.plan).toMatchObject({
      displayName: "Ada Lovelace",
      tzOffsetMinutes: 60,
      capacity: 2,
    });
  });

  it.each([
    [{ cohortId: COHORT, role: "mentee" }, "email"],
    [{ ...valid, cohortId: "not-a-uuid" }, "cohortId"],
    [{ ...valid, role: "" }, "role"],
    [{ ...valid, tzOffsetMinutes: 5000 }, "tzOffsetMinutes"],
    [{ ...valid, cohort_id: COHORT }, ""],
    [{ ...valid, email: "not-an-email" }, "email"],
  ])("400s %j with a field error on %s", async (body, field) => {
    const { post, enrollment } = await listen();
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues: { field: string }[] };
    expect(json.error).toBe("invalid invite");
    expect(json.issues.map((i) => i.field)).toContain(field);
    expect(enrollment.calls).toHaveLength(0);
  });

  it("400s invalid JSON", async () => {
    const { post } = await listen();
    expect((await post("{nope")).status).toBe(400);
  });

  it("400s an unknown cohort and a role the program does not define", async () => {
    const { post, issued } = await listen();
    const cohort = await post({ ...valid, cohortId: "44444444-4444-4444-4444-444444444444" });
    expect(cohort.status).toBe(400);
    expect(await cohort.json()).toMatchObject({ issues: [{ field: "cohortId" }] });
    const role = await post({ ...valid, role: "sponsor" });
    expect(role.status).toBe(400);
    const roleBody = (await role.json()) as { issues: { field: string; message: string }[] };
    expect(roleBody.issues[0]!.field).toBe("role");
    expect(roleBody.issues[0]!.message).toContain("mentor, mentee");
    expect(issued).toHaveLength(0);
  });

  it("501s, after authenticating, when enrolment is not configured", async () => {
    const { post } = await listen({}, false);
    expect((await post(valid, { cookie: null })).status).toBe(401);
    expect((await post(valid)).status).toBe(501);
  });

  it("accepts the invite when the invitee follows their link, with the same verify response as any sign-in", async () => {
    const { base, post, issued, enrollment } = await listen();
    await post(valid);
    await post({ ...valid, role: "mentor" });
    const token = issued.at(-1)!.token;

    const res = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(enrollment.accepted).toEqual([{ orgId: ORG, userId: "user-1" }]);
    expect([...enrollment.invites.values()].map((r) => r.state)).toEqual([
      "enrolled",
      "enrolled",
    ]);
  });

  it("still signs someone in when accepting their invites throws, and reports it", async () => {
    const { base, post, issued, enrollment, unhandled } = await listen();
    await post(valid);
    enrollment.failAccept = true;
    const res = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued[0]!.token }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("mentorship_session=");
    expect(unhandled).toContain("invite_accept_failed");
  });

  it("a failed verify accepts nothing", async () => {
    const { base, enrollment } = await listen();
    const res = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "deadbeef" }),
    });
    expect(res.status).toBe(401);
    expect(enrollment.accepted).toHaveLength(0);
  });
});
