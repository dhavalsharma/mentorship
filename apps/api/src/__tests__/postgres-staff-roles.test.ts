import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStaffDirectory } from "@mentorship/auth/postgres";
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
} from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { buildPostgresApiDeps } from "../postgres-deps.js";
import { createServer } from "../server.js";
import { ActorNotAdminError, grantStaffRole, LastAdminError } from "../staff-grants.js";

/**
 * ADR-0010 against a real database, as `mentorship_app` so RLS is live:
 * the `users.staff_role` column and its CHECK, `PostgresStaffDirectory`'s
 * tenancy, the `pnpm staff:grant` function's writes and audit rows — and
 * the regression itself: a participant invited through the API, signed in
 * through their own magic link, is refused by the admin routes.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

const ROLE = "mentorship_app";

describe.skipIf(!DATABASE_URL)("staff roles on Postgres", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  /** Its own org, so "how many admins are there" is only what these tests made. */
  const mgmtOrgId = randomUUID();
  let mgmtBase: string;
  const programId = randomUUID();
  const cohortId = randomUUID();

  const servers: Server[] = [];
  const issued: { email: string; token: string }[] = [];
  let base: string;

  async function sessionFor(org: string, userId: string): Promise<string> {
    const [row] = await handle.db
      .insert(authSessions)
      .values({ orgId: org, userId, expiresAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: authSessions.id });
    return `mentorship_session=${row!.id}`;
  }

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Staff", slug: `staff-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Other", slug: `staff-${otherOrgId.slice(0, 8)}` },
      { id: mgmtOrgId, name: "Managed", slug: `staff-${mgmtOrgId.slice(0, 8)}` },
    ]);
    await handle.db
      .insert(programs)
      .values({ id: programId, orgId, name: "Mentoring", policy: defaultPolicy() });
    await handle.db.insert(cohorts).values({
      id: cohortId,
      orgId,
      programId,
      name: "2026",
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-12-31T00:00:00.000Z"),
    });

    const server = createServer(
      buildPostgresApiDeps({
        db: handle.db,
        orgId,
        slackSigningSecret: "unused",
        role: ROLE,
        onMagicLinkIssued: (email, token) => issued.push({ email, token }),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const mgmt = createServer(
      buildPostgresApiDeps({ db: handle.db, orgId: mgmtOrgId, slackSigningSecret: "unused", role: ROLE }),
    );
    await new Promise<void>((resolve) => mgmt.listen(0, resolve));
    servers.push(mgmt);
    mgmtBase = `http://127.0.0.1:${(mgmt.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    if (!handle) return;
    const orgs = [orgId, otherOrgId, mgmtOrgId];
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

  const audits = (subjectUserId: string) =>
    handle.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.action, "staff.role_changed"),
          eq(auditLog.subjectRef, `user:${subjectUserId}`),
        ),
      )
      .orderBy(auditLog.createdAt);

  describe("grantStaffRole", () => {
    it("creates a missing user as staff, and audits the change from not-staff", async () => {
      const result = await grantStaffRole(
        handle.db,
        { orgId, email: " Grace@Example.com ", staffRole: "admin", actorRef: "cli:test" },
        { role: ROLE },
      );
      expect(result).toMatchObject({
        email: "grace@example.com",
        createdUser: true,
        before: null,
        after: "admin",
        changed: true,
      });
      const [u] = await handle.db.select().from(users).where(eq(users.id, result.userId));
      expect(u).toMatchObject({
        orgId,
        email: "grace@example.com",
        displayName: "grace",
        staffRole: "admin",
      });
      const rows = await audits(result.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: "operator",
        actorRef: "cli:test",
        before: { staffRole: null },
        after: { staffRole: "admin" },
      });
    });

    it("updates and clears an existing user's role without touching their name or zone", async () => {
      const userId = randomUUID();
      await handle.db.insert(users).values({
        id: userId,
        orgId,
        email: "hopper@example.com",
        displayName: "Grace Hopper",
        tzOffsetMinutes: -300,
      });

      const lead = await grantStaffRole(
        handle.db,
        { orgId, email: "hopper@example.com", staffRole: "program_lead", displayName: "Ignored" },
        { role: ROLE },
      );
      expect(lead).toMatchObject({ userId, createdUser: false, before: null, after: "program_lead" });

      const cleared = await grantStaffRole(
        handle.db,
        { orgId, email: "hopper@example.com", staffRole: null },
        { role: ROLE },
      );
      expect(cleared).toMatchObject({ before: "program_lead", after: null, changed: true });

      const [u] = await handle.db.select().from(users).where(eq(users.id, userId));
      expect(u).toMatchObject({ displayName: "Grace Hopper", tzOffsetMinutes: -300, staffRole: null });
      const rows = await audits(userId);
      expect(rows.map((r) => [r.before, r.after])).toEqual([
        [{ staffRole: null }, { staffRole: "program_lead" }],
        [{ staffRole: "program_lead" }, { staffRole: null }],
      ]);
    });

    it("refuses an org id that names no organisation, and writes nothing", async () => {
      const ghost = randomUUID();
      await expect(
        grantStaffRole(
          handle.db,
          { orgId: ghost, email: "ghost@example.com", staffRole: "admin" },
          { role: ROLE },
        ),
      ).rejects.toThrow(/no organisation/);
      const rows = await handle.db.select().from(users).where(eq(users.orgId, ghost));
      expect(rows).toHaveLength(0);
    });

    it("a no-op grant writes no audit row", async () => {
      const first = await grantStaffRole(
        handle.db,
        { orgId, email: "noop@example.com", staffRole: "admin" },
        { role: ROLE },
      );
      const again = await grantStaffRole(
        handle.db,
        { orgId, email: "noop@example.com", staffRole: "admin" },
        { role: ROLE },
      );
      expect(again).toMatchObject({ changed: false, before: "admin", after: "admin" });
      expect(await audits(first.userId)).toHaveLength(1);
    });
  });

  describe("magic-link sign-in and email case", () => {
    it("someone granted in any case gets a link typing any case — and an unknown email is answered the same", async () => {
      await grantStaffRole(
        handle.db,
        { orgId, email: "Case@Example.com", staffRole: "program_lead" },
        { role: ROLE },
      );
      const ask = (email: string) =>
        fetch(`${base}/auth/request-link`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
      const before = issued.length;
      const known = await ask(" CASE@example.COM ");
      const unknown = await ask("Nobody-Here@Example.com");
      expect([known.status, unknown.status]).toEqual([200, 200]);
      expect(await known.json()).toEqual(await unknown.json());
      expect(issued.slice(before)).toHaveLength(1);
    });
  });

  describe("users.staff_role", () => {
    it("the CHECK constraint refuses a role authorize() has never heard of", async () => {
      const userId = randomUUID();
      await handle.db
        .insert(users)
        .values({ id: userId, orgId, email: "bogus@example.com", displayName: "Bogus" });
      await expect(
        handle.sql`UPDATE users SET staff_role = 'superadmin' WHERE id = ${userId}`,
      ).rejects.toThrow(/users_staff_role_check/);
      await expect(
        handle.sql`UPDATE users SET staff_role = 'mentee' WHERE id = ${userId}`,
      ).rejects.toThrow(/users_staff_role_check/);
    });

    it("PostgresStaffDirectory reads the role under RLS, and another org sees nobody", async () => {
      const directory = new PostgresStaffDirectory(handle.db, { role: ROLE });
      const { userId } = await grantStaffRole(
        handle.db,
        { orgId, email: "rls@example.com", staffRole: "program_lead" },
        { role: ROLE },
      );
      expect(await directory.staffRoleOf(orgId, userId)).toBe("program_lead");
      // Asked under org B's tenant, org A's program lead does not exist.
      expect(await directory.staffRoleOf(otherOrgId, userId)).toBeNull();
      expect(await directory.staffRoleOf(orgId, randomUUID())).toBeNull();
    });
  });

  describe("the regression: an invitee's own session is not a staff session", () => {
    it("invite, follow the link, and get 403 from the admin routes — until someone grants a role", async () => {
      const { userId: adminId } = await grantStaffRole(
        handle.db,
        { orgId, email: "admin@example.com", staffRole: "admin" },
        { role: ROLE },
      );
      const adminCookie = await sessionFor(orgId, adminId);

      const invited = await fetch(`${base}/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "mentee@example.com", cohortId, role: "mentee" }),
      });
      expect(invited.status).toBe(201);

      const token = issued.filter((i) => i.email === "mentee@example.com").at(-1)!.token;
      const verify = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(verify.status).toBe(200);
      const menteeCookie = verify.headers.get("set-cookie")!.split(";")[0]!;

      // Signed in for real — the invite was accepted on this very verify.
      const [p] = await handle.db
        .select()
        .from(participants)
        .where(and(eq(participants.orgId, orgId), eq(participants.cohortId, cohortId)));
      expect(p!.state).toBe("enrolled");

      const risk = await fetch(`${base}/orgs/${orgId}/risk-findings`, {
        headers: { cookie: menteeCookie },
      });
      expect(risk.status).toBe(403);
      expect(await risk.json()).toEqual({ error: "forbidden" });

      const reinvite = await fetch(`${base}/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { cookie: menteeCookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "friend@example.com", cohortId, role: "mentee" }),
      });
      expect(reinvite.status).toBe(403);
      const friend = await handle.db
        .select()
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.email, "friend@example.com")));
      expect(friend).toHaveLength(0);

      // The same session, once an operator makes them a program lead, can list.
      await grantStaffRole(
        handle.db,
        { orgId, email: "mentee@example.com", staffRole: "program_lead" },
        { role: ROLE },
      );
      const asLead = await fetch(`${base}/orgs/${orgId}/risk-findings`, {
        headers: { cookie: menteeCookie },
      });
      expect(asLead.status).toBe(200);
      const settings = await fetch(`${base}/orgs/${orgId}/settings/document`, {
        headers: { cookie: menteeCookie },
      });
      expect(settings.status).toBe(403);
    });
  });

  describe("managing staff from the dashboard (GET/PUT /orgs/:orgId/staff)", () => {
    /** Nobody in the managed org is staff at the start of each test. */
    async function reset(): Promise<void> {
      await handle.db.update(users).set({ staffRole: null }).where(eq(users.orgId, mgmtOrgId));
    }

    /** An admin made the bootstrap way — the CLI's function — with a session. */
    async function bootstrapAdmin(email: string): Promise<{ userId: string; cookie: string }> {
      const { userId } = await grantStaffRole(
        handle.db,
        { orgId: mgmtOrgId, email, staffRole: "admin", actorRef: "cli:test" },
        { role: ROLE },
      );
      return { userId, cookie: await sessionFor(mgmtOrgId, userId) };
    }

    const put = (cookie: string, body: unknown) =>
      fetch(`${mgmtBase}/orgs/${mgmtOrgId}/staff`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const list = (cookie: string) =>
      fetch(`${mgmtBase}/orgs/${mgmtOrgId}/staff`, { headers: { cookie } });

    const roleOf = async (email: string) => {
      const [row] = await handle.db
        .select({ staffRole: users.staffRole })
        .from(users)
        .where(and(eq(users.orgId, mgmtOrgId), eq(users.email, email)));
      return row?.staffRole ?? null;
    };
    const adminCount = async () =>
      (
        await handle.db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.orgId, mgmtOrgId), eq(users.staffRole, "admin")))
      ).length;
    const auditsIn = (subjectUserId: string) =>
      handle.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, mgmtOrgId),
            eq(auditLog.action, "staff.role_changed"),
            eq(auditLog.subjectRef, `user:${subjectUserId}`),
          ),
        )
        .orderBy(auditLog.createdAt);

    it("grant then revoke through the route, each audited as the acting admin", async () => {
      await reset();
      const ada = await bootstrapAdmin("ada@mgmt.example.com");

      const granted = await put(ada.cookie, {
        email: "lin@mgmt.example.com",
        role: "program_lead",
        displayName: "Lin",
      });
      expect(granted.status).toBe(200);
      const body = (await granted.json()) as {
        member: { userId: string; email: string; displayName: string; role: string | null };
        changed: boolean;
        createdUser: boolean;
      };
      expect(body).toMatchObject({
        member: { email: "lin@mgmt.example.com", displayName: "Lin", role: "program_lead" },
        changed: true,
        createdUser: true,
      });
      const linId = body.member.userId;

      const listed = (await (await list(ada.cookie)).json()) as { email: string; role: string }[];
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: "ada@mgmt.example.com", role: "admin" }),
          expect.objectContaining({ email: "lin@mgmt.example.com", role: "program_lead" }),
        ]),
      );

      // The same request again is a no-op: 200, changed false, no second row.
      const again = await put(ada.cookie, { email: "lin@mgmt.example.com", role: "program_lead" });
      expect(await again.json()).toMatchObject({ changed: false });

      const revoked = await put(ada.cookie, { email: "lin@mgmt.example.com", role: "none" });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ changed: true, member: { role: null } });
      expect(await roleOf("lin@mgmt.example.com")).toBeNull();

      const rows = await auditsIn(linId);
      expect(rows.map((r) => [r.actorType, r.actorRef, r.before, r.after])).toEqual([
        ["admin", ada.userId, { staffRole: null }, { staffRole: "program_lead" }],
        ["admin", ada.userId, { staffRole: "program_lead" }, { staffRole: null }],
      ]);
    });

    it("another org's staff never appear in the list", async () => {
      await reset();
      const ada = await bootstrapAdmin("ada@mgmt.example.com");
      await grantStaffRole(
        handle.db,
        { orgId: otherOrgId, email: "foreign-admin@other.example.com", staffRole: "admin" },
        { role: ROLE },
      );
      const listed = (await (await list(ada.cookie)).json()) as { email: string }[];
      expect(listed.map((m) => m.email)).toEqual(["ada@mgmt.example.com"]);

      // Naming a foreign admin's email cannot reach their row: under RLS it
      // does not exist here, so revoking it is a 404 and theirs is untouched.
      const res = await put(ada.cookie, { email: "foreign-admin@other.example.com", role: "none" });
      expect(res.status).toBe(404);
      const [foreign] = await handle.db
        .select({ staffRole: users.staffRole })
        .from(users)
        .where(and(eq(users.orgId, otherOrgId), eq(users.email, "foreign-admin@other.example.com")));
      expect(foreign!.staffRole).toBe("admin");
    });

    it("refuses to remove the last admin, including themselves, and writes nothing", async () => {
      await reset();
      const ada = await bootstrapAdmin("ada@mgmt.example.com");
      const before = (await auditsIn(ada.userId)).length;

      for (const role of ["none", "program_lead"]) {
        const res = await put(ada.cookie, { email: "ada@mgmt.example.com", role });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ reason: "last_admin" });
      }
      expect(await roleOf("ada@mgmt.example.com")).toBe("admin");
      expect(await auditsIn(ada.userId)).toHaveLength(before);
    });

    it("the CLI is not guarded — an operator may still revoke a sole admin", async () => {
      await reset();
      const ada = await bootstrapAdmin("ada@mgmt.example.com");
      const result = await grantStaffRole(
        handle.db,
        { orgId: mgmtOrgId, email: "ada@mgmt.example.com", staffRole: null, actorRef: "cli:test" },
        { role: ROLE },
      );
      expect(result).toMatchObject({ userId: ada.userId, changed: true, after: null });
    });

    it("two admins demoting each other at once leave exactly one admin", async () => {
      // Repeated, because a race that passes once may just have been lucky
      // with scheduling; the deterministic interleaving is the next test.
      for (let round = 0; round < 8; round++) {
        await reset();
        const x = await bootstrapAdmin("x@mgmt.example.com");
        const y = await bootstrapAdmin("y@mgmt.example.com");
        const [a, b] = await Promise.all([
          put(x.cookie, { email: "y@mgmt.example.com", role: "none" }),
          put(y.cookie, { email: "x@mgmt.example.com", role: "none" }),
        ]);
        // The loser is refused either by the guard (409, both got past auth
        // before either committed) or by auth itself (403, the winner had
        // already committed and they are no longer an admin). Never a second 200.
        const statuses = [a.status, b.status].sort();
        expect(statuses[0]).toBe(200);
        expect([403, 409]).toContain(statuses[1]);
        expect(await adminCount()).toBe(1);
      }
    });

    it("a guarded demotion waits for a concurrent one to commit, then refuses", async () => {
      await reset();
      const x = await bootstrapAdmin("x@mgmt.example.com");
      await bootstrapAdmin("y@mgmt.example.com");

      let settled: "pending" | "fulfilled" | "rejected" = "pending";
      let outcome: Promise<unknown> | undefined;
      // Transaction 1 demotes Y and holds it open while transaction 2
      // (demote X) starts. It locks *only Y's row* — not X's — so the one
      // thing that can keep transaction 2 waiting is its lock on the whole
      // admin set; its own `FOR UPDATE` on the target (X) is free to take.
      // Without the admin-set lock, "pending" below is what fails first.
      await handle.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${ROLE}`);
        await tx`select set_config('app.current_org', ${mgmtOrgId}, true)`;
        await tx`select id from users where org_id = ${mgmtOrgId}
                 and email = 'y@mgmt.example.com' for update`;
        await tx`update users set staff_role = null
                 where org_id = ${mgmtOrgId} and email = 'y@mgmt.example.com'`;

        outcome = grantStaffRole(
          handle.db,
          {
            orgId: mgmtOrgId,
            email: "x@mgmt.example.com",
            staffRole: null,
            actorType: "admin",
            actorRef: x.userId,
            protectLastAdmin: true,
          },
          { role: ROLE },
        ).then(
          (result) => {
            settled = "fulfilled";
            return result;
          },
          // Caught here, not rethrown, so the rejection is never unhandled
          // while transaction 1 is still committing.
          (error: unknown) => {
            settled = "rejected";
            return error;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Blocked on transaction 1's lock on Y, not decided on a stale count.
        expect(settled).toBe("pending");
      });

      expect(await outcome).toBeInstanceOf(LastAdminError);
      expect(settled).toBe("rejected");
      expect(await roleOf("x@mgmt.example.com")).toBe("admin");
      expect(await adminCount()).toBe(1);
    });

    /**
     * Settle a promise into a value either way, recording when, so a test
     * can assert it is still waiting on a lock — and so a rejection is never
     * unhandled while the transaction holding that lock is still open.
     */
    function track<T>(promise: Promise<T>) {
      const state = { settled: false, value: undefined as unknown };
      const done = promise.then(
        (v) => {
          state.settled = true;
          state.value = v;
          return v as unknown;
        },
        (e: unknown) => {
          state.settled = true;
          state.value = e;
          return e;
        },
      );
      return { state, done };
    }

    const guarded = (actorRef: string, email: string, staffRole: "admin" | "program_lead" | null) =>
      grantStaffRole(
        handle.db,
        { orgId: mgmtOrgId, email, staffRole, actorType: "admin", actorRef, protectLastAdmin: true },
        { role: ROLE },
      );

    it("an admin demoted while their request was queued cannot re-promote themselves or anyone else", async () => {
      await reset();
      const a = await bootstrapAdmin("a@mgmt.example.com");
      await bootstrapAdmin("b@mgmt.example.com");
      const auditsByA = async () =>
        (
          await handle.db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(and(eq(auditLog.orgId, mgmtOrgId), eq(auditLog.actorRef, a.userId)))
        ).length;
      const auditsBefore = await auditsByA();

      let selfPromote: ReturnType<typeof track> | undefined;
      let accomplice: ReturnType<typeof track> | undefined;
      // Transaction 1 is B's demotion of A, done the way a guarded grant does
      // it: lock the admin set, demote. A's two requests have already passed
      // auth (A *was* an admin) and are queued behind it.
      await handle.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${ROLE}`);
        await tx`select set_config('app.current_org', ${mgmtOrgId}, true)`;
        await tx`select id from users where org_id = ${mgmtOrgId} and staff_role = 'admin'
                 order by id for update`;
        await tx`update users set staff_role = null
                 where org_id = ${mgmtOrgId} and email = 'a@mgmt.example.com'`;

        selfPromote = track(guarded(a.userId, "a@mgmt.example.com", "admin"));
        accomplice = track(guarded(a.userId, "c@mgmt.example.com", "admin"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(selfPromote.state.settled).toBe(false);
        expect(accomplice.state.settled).toBe(false);
      });

      expect(await selfPromote!.done).toBeInstanceOf(ActorNotAdminError);
      expect(await accomplice!.done).toBeInstanceOf(ActorNotAdminError);
      expect(await roleOf("a@mgmt.example.com")).toBeNull();
      // Not promoted, and not even created: the insert rolled back with the rest.
      const c = await handle.db
        .select()
        .from(users)
        .where(and(eq(users.orgId, mgmtOrgId), eq(users.email, "c@mgmt.example.com")));
      expect(c).toHaveLength(0);
      expect(await auditsByA()).toBe(auditsBefore);
      expect(await adminCount()).toBe(1);
    });

    it("a self-demotion queued behind a promotion refuses — spuriously, never unsafely", async () => {
      await reset();
      const a = await bootstrapAdmin("a@mgmt.example.com");
      await handle.db
        .insert(users)
        .values({ orgId: mgmtOrgId, email: "c@mgmt.example.com", displayName: "C" })
        .onConflictDoNothing();

      let demote: ReturnType<typeof track> | undefined;
      // Transaction 1 is A promoting C, lock taken and write made, held open.
      await handle.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${ROLE}`);
        await tx`select set_config('app.current_org', ${mgmtOrgId}, true)`;
        await tx`select id from users where org_id = ${mgmtOrgId} and staff_role = 'admin'
                 order by id for update`;
        await tx`update users set staff_role = 'admin'
                 where org_id = ${mgmtOrgId} and email = 'c@mgmt.example.com'`;

        demote = track(guarded(a.userId, "a@mgmt.example.com", null));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(demote.state.settled).toBe(false);
      });

      // Its snapshot predates C's promotion, so it counts only A: a refusal
      // an admin can simply retry, where the opposite error would be a
      // tenant with no admin.
      expect(await demote!.done).toBeInstanceOf(LastAdminError);
      expect(await roleOf("a@mgmt.example.com")).toBe("admin");
      expect(await adminCount()).toBe(2);
    });

    it("a promotion racing a self-demotion never leaves the org with no admin", async () => {
      for (let round = 0; round < 8; round++) {
        await reset();
        const a = await bootstrapAdmin("a@mgmt.example.com");
        const [promote, demote] = await Promise.all([
          put(a.cookie, { email: "c@mgmt.example.com", role: "admin" }),
          put(a.cookie, { email: "a@mgmt.example.com", role: "none" }),
        ]);
        // Either order is fine; what is not is both succeeding with the
        // demotion having counted a promotion that had not committed.
        expect(await adminCount()).toBeGreaterThanOrEqual(1);
        // The promotion always lands: A is still admin whenever it holds the
        // lock (a demotion that committed first saw C, so C was already admin).
        expect(promote.status).toBe(200);
        expect([200, 409]).toContain(demote.status);
        expect(await roleOf("c@mgmt.example.com")).toBe("admin");
        expect(await roleOf("a@mgmt.example.com")).toBe(demote.status === 200 ? null : "admin");
      }
    });

    it("two concurrent grants for one new email make one user and a consistent audit trail", async () => {
      for (let round = 0; round < 8; round++) {
        await reset();
        const a = await bootstrapAdmin("a@mgmt.example.com");
        const email = `new-${round}-${randomUUID().slice(0, 8)}@mgmt.example.com`;
        const responses = await Promise.all([
          put(a.cookie, { email, role: "program_lead" }),
          put(a.cookie, { email, role: "admin" }),
        ]);
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
          member: { userId: string };
          createdUser: boolean;
          changed: boolean;
        }[];

        const rows = await handle.db
          .select()
          .from(users)
          .where(and(eq(users.orgId, mgmtOrgId), eq(users.email, email)));
        expect(rows).toHaveLength(1);
        const userId = rows[0]!.id;
        expect(bodies.map((b) => b.member.userId)).toEqual([userId, userId]);
        expect(bodies.filter((b) => b.createdUser)).toHaveLength(1);

        // Two different roles, so both change something: the trail must chain
        // — one row starts from not-staff, the other's `before` is that row's
        // `after` — and end on the role the user actually has. Chained by
        // content, not sorted by `created_at`: that column is `now()`, the
        // *transaction's* start, so the grant that waited on the other's lock
        // can carry the earlier timestamp while having committed second.
        const trail = await auditsIn(userId);
        expect(trail).toHaveLength(2);
        const first = trail.find((r) => (r.before as { staffRole: unknown }).staffRole === null);
        const second = trail.find((r) => r !== first);
        expect(first).toBeDefined();
        expect(second!.before).toEqual(first!.after);
        expect(second!.after).toEqual({ staffRole: rows[0]!.staffRole });
      }
    });

    it("a revoked user's very next request is refused", async () => {
      await reset();
      const ada = await bootstrapAdmin("ada@mgmt.example.com");
      const bo = await bootstrapAdmin("bo@mgmt.example.com");
      expect((await list(bo.cookie)).status).toBe(200);

      expect((await put(ada.cookie, { email: "bo@mgmt.example.com", role: "program_lead" })).status).toBe(200);
      // A program lead keeps the lists but not staff management.
      expect((await list(bo.cookie)).status).toBe(403);
      const risk = await fetch(`${mgmtBase}/orgs/${mgmtOrgId}/risk-findings`, {
        headers: { cookie: bo.cookie },
      });
      expect(risk.status).toBe(200);

      expect((await put(ada.cookie, { email: "bo@mgmt.example.com", role: "none" })).status).toBe(200);
      const after = await fetch(`${mgmtBase}/orgs/${mgmtOrgId}/risk-findings`, {
        headers: { cookie: bo.cookie },
      });
      expect(after.status).toBe(403);
    });
  });
});
