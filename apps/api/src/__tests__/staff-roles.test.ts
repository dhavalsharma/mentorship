import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MagicLinkStore } from "@mentorship/auth";
import type { StaffRole } from "@mentorship/core";
import type { InvitePlan } from "@mentorship/enrollment";
import { FakeStaffDirectory } from "./staff-fake.js";
import {
  createServer,
  type DocumentSettings,
  type EnrollmentService,
  type InviteOutcome,
  type SheetSettings,
} from "../server.js";

/**
 * ADR-0010: a valid session is not a staff session. Every staff route is
 * listed below — enumerated, not sampled, because the bug this suite pins
 * down was a gate that every route *assumed* someone else had applied. A new
 * staff route belongs in `STAFF_ROUTES` with the roles it admits; forgetting
 * to add it is the only way this suite can miss one.
 *
 * The Postgres half — the real column, RLS, and an invitee's own session
 * being refused — is `postgres-staff-roles.test.ts`.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const COHORT = "33333333-3333-3333-3333-333333333333";
const RUN = "44444444-4444-4444-4444-444444444444";

interface StaffRoute {
  name: string;
  method: "GET" | "PUT" | "POST";
  path: string;
  body?: unknown;
  /** Which staff roles `authorize()` admits. A non-staff session is always refused. */
  allows: readonly StaffRole[];
}

const BOTH: readonly StaffRole[] = ["admin", "program_lead"];
const ADMIN_ONLY: readonly StaffRole[] = ["admin"];

const STAFF_ROUTES: readonly StaffRoute[] = [
  { name: "list risk findings", method: "GET", path: `/orgs/${ORG}/risk-findings`, allows: BOTH },
  { name: "list nudges", method: "GET", path: `/orgs/${ORG}/nudges`, allows: BOTH },
  { name: "list stuck sagas", method: "GET", path: `/orgs/${ORG}/stuck-sagas`, allows: BOTH },
  { name: "list dead letters", method: "GET", path: `/orgs/${ORG}/dead-letters`, allows: BOTH },
  {
    name: "list pair preference changes",
    method: "GET",
    path: `/orgs/${ORG}/pair-preference-changes`,
    allows: BOTH,
  },
  {
    name: "read matching-round candidates",
    method: "GET",
    path: `/orgs/${ORG}/matching-rounds/${RUN}/candidates`,
    allows: BOTH,
  },
  {
    name: "invite into a cohort",
    method: "POST",
    path: `/orgs/${ORG}/invites`,
    body: { email: "new@example.com", cohortId: COHORT, role: "mentee" },
    allows: BOTH,
  },
  {
    name: "read document settings",
    method: "GET",
    path: `/orgs/${ORG}/settings/document`,
    allows: ADMIN_ONLY,
  },
  {
    name: "write document settings",
    method: "PUT",
    path: `/orgs/${ORG}/settings/document`,
    body: { folder: "FOLDER_1" },
    allows: ADMIN_ONLY,
  },
  {
    name: "read sheet settings",
    method: "GET",
    path: `/orgs/${ORG}/settings/sheet`,
    allows: ADMIN_ONLY,
  },
  {
    name: "write sheet settings",
    method: "PUT",
    path: `/orgs/${ORG}/settings/sheet`,
    body: { folder: "FOLDER_1" },
    allows: ADMIN_ONLY,
  },
  { name: "list staff", method: "GET", path: `/orgs/${ORG}/staff`, allows: ADMIN_ONLY },
  {
    name: "grant or revoke a staff role",
    method: "PUT",
    path: `/orgs/${ORG}/staff`,
    body: { email: "lead@example.com", role: "program_lead" },
    allows: ADMIN_ONLY,
  },
];

/** Links and sessions in memory; users by email. */
class FakeMagicLinkStore implements MagicLinkStore {
  users = new Map<string, string>();
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

/** Every backing port counts its calls, so a refused request can prove it touched none. */
function backends(links: FakeMagicLinkStore) {
  const touched: string[] = [];
  const list = (name: string) => async () => {
    touched.push(name);
    return [];
  };
  let documentSettings: DocumentSettings = {
    folderId: null,
    guidelineDocId: null,
    namingTemplate: "{{pairTitle}} — session notes",
  };
  let sheetSettings: SheetSettings = { folderId: null, spreadsheetId: null };
  const enrollment: EnrollmentService = {
    async invite(_orgId: string, plan: InvitePlan): Promise<InviteOutcome> {
      touched.push("invite");
      const userId = links.users.get(plan.email) ?? `user-invitee-${links.users.size + 1}`;
      links.users.set(plan.email, userId);
      return { ok: true, participantId: "p-1", alreadyInvited: false, state: "invited" };
    },
    async acceptPendingInvites() {
      return { accepted: ["p-1"] };
    },
  };
  return {
    touched,
    deps: {
      admin: {
        riskFindings: list("riskFindings"),
        nudges: list("nudges"),
        stuckSagas: list("stuckSagas"),
        deadLetters: list("deadLetters"),
        pairPreferenceChanges: async () => {
          touched.push("pairPreferenceChanges");
          return { changes: [], skipped: 0 };
        },
        matchingRoundCandidates: async () => {
          touched.push("matchingRoundCandidates");
          return { runId: RUN, candidates: [] };
        },
      },
      documentSettings: {
        read: async () => {
          touched.push("documentSettings.read");
          return documentSettings;
        },
        write: async (_orgId: string, next: DocumentSettings) => {
          touched.push("documentSettings.write");
          documentSettings = next;
        },
      },
      sheetSettings: {
        read: async () => {
          touched.push("sheetSettings.read");
          return sheetSettings;
        },
        write: async (_orgId: string, next: SheetSettings) => {
          touched.push("sheetSettings.write");
          sheetSettings = next;
        },
      },
      enrollment,
      staffAdmin: {
        list: async () => {
          touched.push("staffAdmin.list");
          return [];
        },
        setRole: async (_orgId: string, change: { email: string; staffRole: StaffRole | null }) => {
          touched.push("staffAdmin.setRole");
          return {
            ok: true as const,
            member: { userId: "u", email: change.email, displayName: "u", role: change.staffRole },
            changed: true,
            createdUser: false,
          };
        },
      },
    },
  };
}

describe("staff roles gate every admin route", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen() {
    const links = new FakeMagicLinkStore();
    // Nobody is staff unless granted — the state migration 0017 leaves.
    const staff = new FakeStaffDirectory(null);
    const { touched, deps } = backends(links);
    const issued: { email: string; token: string }[] = [];
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: { resolveParticipantId: async () => null },
      responder: { respond: async () => {} },
      auth: {
        store: links,
        staff,
        orgId: ORG,
        onMagicLinkIssued: (email, token) => issued.push({ email, token }),
      },
      ...deps,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const sessionAs = (userId: string, role: StaffRole | null): string => {
      staff.set(ORG, userId, role);
      return `mentorship_session=${links.seedSession(ORG, userId)}`;
    };
    const call = (route: StaffRoute, cookie: string | null) =>
      fetch(`${base}${route.path}`, {
        method: route.method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(route.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
      });
    return { base, call, sessionAs, touched, staff, issued };
  }

  it("covers thirteen routes — a new staff route must be added to STAFF_ROUTES", () => {
    expect(STAFF_ROUTES.map((r) => `${r.method} ${r.path}`)).toHaveLength(13);
  });

  describe.each(STAFF_ROUTES)("$method $name", (route) => {
    it("401s with no session", async () => {
      const { call, touched } = await listen();
      const res = await call(route, null);
      expect(res.status).toBe(401);
      expect(touched).toEqual([]);
    });

    it("403s a signed-in user who is not staff, with the same body as a wrong-org 403, touching no backend", async () => {
      const { call, sessionAs, touched } = await listen();
      const res = await call(route, sessionAs("user-mentee", null));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect(touched).toEqual([]);
    });

    for (const role of ["admin", "program_lead"] as const) {
      const allowed = route.allows.includes(role);
      it(`${allowed ? "admits" : "403s"} ${role}`, async () => {
        const { call, sessionAs, touched } = await listen();
        const res = await call(route, sessionAs(`user-${role}`, role));
        if (allowed) {
          expect([200, 201]).toContain(res.status);
          expect(touched).toHaveLength(1);
        } else {
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: "forbidden" });
          expect(touched).toEqual([]);
        }
      });
    }
  });

  it("an invitee who follows their magic link is signed in, and refused by every staff route", async () => {
    const { base, call, sessionAs, issued } = await listen();
    const admin = sessionAs("user-admin", "admin");
    const invite = STAFF_ROUTES.find((r) => r.method === "POST")!;
    expect((await call(invite, admin)).status).toBe(201);

    const verify = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.at(-1)!.token }),
    });
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;

    for (const route of STAFF_ROUTES) {
      const res = await call(route, cookie);
      expect({ route: route.name, status: res.status }).toEqual({
        route: route.name,
        status: 403,
      });
    }
  });

  it("revoking a role takes effect on the very next request — nothing caches it on the session", async () => {
    const { call, sessionAs, staff } = await listen();
    const cookie = sessionAs("user-lead", "program_lead");
    const route = STAFF_ROUTES[0]!;
    expect((await call(route, cookie)).status).toBe(200);
    staff.set(ORG, "user-lead", null);
    expect((await call(route, cookie)).status).toBe(403);
  });
});
