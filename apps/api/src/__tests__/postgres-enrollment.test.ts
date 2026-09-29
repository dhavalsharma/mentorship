import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import {
  auditLog,
  authSessions,
  cohorts,
  identityLinks,
  magicLinks,
  organizations,
  participants,
  programs,
  users,
  withTenant,
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { buildPostgresApiDeps } from "../postgres-deps.js";
import { createServer } from "../server.js";

/**
 * The invite route and accept-on-sign-in against a real database, through
 * the same `buildPostgresApiDeps` `main.ts` ships, as the unprivileged
 * `mentorship_app` role so RLS is live: the invite lands under the right
 * org, a repeat dedupes on real rows, a foreign org's admin is refused and
 * cannot even see this org's cohort, and both audit rows are written.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

const ROLE = "mentorship_app";

describe.skipIf(!DATABASE_URL)("cohort invites on Postgres", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const programId = randomUUID();
  const otherProgramId = randomUUID();
  const cohortId = randomUUID();
  const otherCohortId = randomUUID();
  const adminUserId = randomUUID();
  const otherAdminUserId = randomUUID();

  const servers: Server[] = [];
  const issued: { email: string; token: string }[] = [];
  let base: string;
  let otherBase: string;
  let adminCookie: string;
  let otherAdminCookie: string;

  async function listen(boundOrg: string): Promise<string> {
    const server = createServer(
      buildPostgresApiDeps({
        db: handle.db,
        orgId: boundOrg,
        slackSigningSecret: "unused",
        role: ROLE,
        onMagicLinkIssued: (email, token) => issued.push({ email, token }),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function sessionFor(org: string, userId: string): Promise<string> {
    const [row] = await handle.db
      .insert(authSessions)
      .values({ orgId: org, userId, expiresAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: authSessions.id });
    return `mentorship_session=${row!.id}`;
  }

  const invite = (url: string, cookie: string, org: string, body: unknown) =>
    fetch(`${url}/orgs/${org}/invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Invites", slug: `invites-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Other", slug: `invites-${otherOrgId.slice(0, 8)}` },
    ]);
    await handle.db.insert(programs).values([
      { id: programId, orgId, name: "Mentoring", policy: defaultPolicy() },
      { id: otherProgramId, orgId: otherOrgId, name: "Mentoring", policy: defaultPolicy() },
    ]);
    const span = {
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-12-31T00:00:00.000Z"),
    };
    await handle.db.insert(cohorts).values([
      { id: cohortId, orgId, programId, name: "2026", ...span },
      { id: otherCohortId, orgId: otherOrgId, programId: otherProgramId, name: "2026", ...span },
    ]);
    await handle.db.insert(users).values([
      {
        id: adminUserId,
        orgId,
        email: "admin@example.com",
        displayName: "Admin",
        staffRole: "admin",
      },
      {
        id: otherAdminUserId,
        orgId: otherOrgId,
        email: "admin@other.example.com",
        displayName: "Other admin",
        staffRole: "admin",
      },
    ]);
    adminCookie = await sessionFor(orgId, adminUserId);
    otherAdminCookie = await sessionFor(otherOrgId, otherAdminUserId);
    base = await listen(orgId);
    otherBase = await listen(otherOrgId);
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    if (!handle) return;
    const orgs = [orgId, otherOrgId];
    await handle.db.delete(auditLog).where(inArray(auditLog.orgId, orgs));
    await handle.db.delete(identityLinks).where(inArray(identityLinks.orgId, orgs));
    await handle.db.delete(authSessions).where(inArray(authSessions.orgId, orgs));
    await handle.db.delete(magicLinks).where(inArray(magicLinks.orgId, orgs));
    await handle.db.delete(participants).where(inArray(participants.orgId, orgs));
    await handle.db.delete(users).where(inArray(users.orgId, orgs));
    await handle.db.delete(cohorts).where(inArray(cohorts.orgId, orgs));
    await handle.db.delete(programs).where(inArray(programs.orgId, orgs));
    await handle.db.delete(organizations).where(inArray(organizations.id, orgs));
    await handle.close();
  });

  const ada = { email: "Ada@Example.com", cohortId, role: "mentee" };
  let participantId: string;

  it("writes an invited participant, its user and a participant.invited audit row under RLS", async () => {
    const res = await invite(base, adminCookie, orgId, ada);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { participantId: string; signInLinkIssued: boolean };
    participantId = body.participantId;
    expect(body.signInLinkIssued).toBe(true);

    // Read back as the app role inside this org: the rows are visible here...
    const mine = await withTenant(
      handle.db,
      orgId,
      async (tx) => {
        const [p] = await tx
          .select()
          .from(participants)
          .where(eq(participants.id, participantId));
        const [u] = await tx.select().from(users).where(eq(users.id, p!.userId));
        const audits = await tx
          .select()
          .from(auditLog)
          .where(eq(auditLog.subjectRef, `participant:${participantId}`));
        return { p, u, audits };
      },
      { role: ROLE },
    );
    expect(mine.p).toMatchObject({ orgId, cohortId, role: "mentee", state: "invited" });
    expect(mine.u).toMatchObject({ orgId, email: "ada@example.com", displayName: "Ada" });
    expect(mine.audits).toHaveLength(1);
    expect(mine.audits[0]).toMatchObject({
      orgId,
      actorType: "admin",
      actorRef: adminUserId,
      action: "participant.invited",
    });

    // ...and invisible from the other org.
    const theirs = await withTenant(
      handle.db,
      otherOrgId,
      (tx) => tx.select().from(participants).where(eq(participants.id, participantId)),
      { role: ROLE },
    );
    expect(theirs).toHaveLength(0);
  });

  it("dedupes a repeat invite onto the same row, with no second audit row", async () => {
    const res = await invite(base, adminCookie, orgId, { ...ada, email: "ada@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ participantId, alreadyInvited: true, state: "invited" });

    const rows = await handle.db
      .select()
      .from(participants)
      .where(eq(participants.orgId, orgId));
    expect(rows.filter((r) => r.role === "mentee")).toHaveLength(1);
    const audits = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "participant.invited")));
    expect(audits).toHaveLength(1);
  });

  it("refuses a foreign org's admin with 403, and hides this org's cohort from them", async () => {
    // The other org's admin, on the server bound to their own org, naming this org.
    const cross = await invite(otherBase, otherAdminCookie, orgId, ada);
    expect(cross.status).toBe(403);

    // Their session does not resolve at all on this org's server.
    const wrongServer = await invite(base, otherAdminCookie, orgId, ada);
    expect(wrongServer.status).toBe(401);

    // Naming their own org but this org's cohort: RLS makes it not exist.
    const foreignCohort = await invite(otherBase, otherAdminCookie, otherOrgId, ada);
    expect(foreignCohort.status).toBe(400);
    expect(await foreignCohort.json()).toMatchObject({ issues: [{ field: "cohortId" }] });

    const leaked = await handle.db
      .select()
      .from(participants)
      .where(eq(participants.orgId, otherOrgId));
    expect(leaked).toHaveLength(0);
  });

  it("400s a role the cohort's program does not define", async () => {
    const res = await invite(base, adminCookie, orgId, { ...ada, role: "sponsor" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ issues: [{ field: "role" }] });
  });

  it("enrols the invitee when they follow their link: an email identity, enrolled, identity.verified audited", async () => {
    const token = issued.filter((i) => i.email === "ada@example.com").at(-1)!.token;
    const res = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [p] = await handle.db
      .select()
      .from(participants)
      .where(eq(participants.id, participantId));
    expect(p!.state).toBe("enrolled");

    const links = await handle.db
      .select()
      .from(identityLinks)
      .where(and(eq(identityLinks.orgId, orgId), eq(identityLinks.userId, p!.userId)));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ provider: "email", externalId: "ada@example.com" });
    expect(links[0]!.verifiedAt).not.toBeNull();

    const verified = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "identity.verified")));
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      actorType: "user",
      actorRef: p!.userId,
      subjectRef: `participant:${participantId}`,
    });
  });

  it("an enrolled person's repeat invite issues no link, and a second sign-in changes nothing", async () => {
    const before = issued.length;
    const res = await invite(base, adminCookie, orgId, ada);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "enrolled", signInLinkIssued: false });
    expect(issued.length).toBe(before);

    // A fresh link through the ordinary request-link door, then verify again.
    await fetch(`${base}/auth/request-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    const again = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.at(-1)!.token }),
    });
    expect(again.status).toBe(200);
    const links = await handle.db
      .select()
      .from(identityLinks)
      .where(eq(identityLinks.orgId, orgId));
    expect(links).toHaveLength(1);
    const verified = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "identity.verified")));
    expect(verified).toHaveLength(1);
  });

  it("never overwrites an existing user's name or zone on invite", async () => {
    await handle.db
      .update(users)
      .set({ displayName: "Ada Lovelace", tzOffsetMinutes: 60 })
      .where(and(eq(users.orgId, orgId), eq(users.email, "ada@example.com")));
    const res = await invite(base, adminCookie, orgId, { ...ada, role: "mentor" });
    expect(res.status).toBe(201);
    const [u] = await handle.db
      .select()
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, "ada@example.com")));
    expect(u).toMatchObject({ displayName: "Ada Lovelace", tzOffsetMinutes: 60 });
  });
});
