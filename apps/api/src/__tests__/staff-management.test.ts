import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MagicLinkStore } from "@mentorship/auth";
import { createServer, type ApiServerDeps } from "../server.js";
import { FakeStaffAdmin, FakeStaffDirectory } from "./staff-fake.js";

/**
 * `GET`/`PUT /orgs/:orgId/staff` over a real socket with fakes behind it:
 * body validation, the last-admin 409, the no-op, and a change being live on
 * the target's next request. Who may call the two routes at all is
 * `staff-roles.test.ts`'s enumerated matrix; the transaction, the audit row
 * and the concurrent-demotion race are `postgres-staff-roles.test.ts`.
 */

const ORG = "11111111-1111-1111-1111-111111111111";

/** Sessions only — nothing here signs in through a link. */
class SessionStore implements MagicLinkStore {
  private readonly sessions = new Map<string, string>();
  private next = 1;
  seed(userId: string): string {
    const id = `sess-${this.next++}`;
    this.sessions.set(id, userId);
    return `mentorship_session=${id}`;
  }
  async findUserByEmail() {
    return null;
  }
  async createLink() {}
  async findUnconsumedLinkByTokenHash() {
    return null;
  }
  async consumeLink() {
    return false;
  }
  async createSession() {
    return { sessionId: "unused" };
  }
  async findActiveSession(_orgId: string, sessionId: string) {
    const userId = this.sessions.get(sessionId);
    return userId
      ? { userId, expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null }
      : null;
  }
}

describe("staff management routes", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(options: { withService?: boolean } = {}) {
    const sessions = new SessionStore();
    const directory = new FakeStaffDirectory(null);
    const staffAdmin = new FakeStaffAdmin(directory, ORG);
    staffAdmin.addPerson("ada@example.com", "user-ada", "admin", "Ada");
    const deps: ApiServerDeps = {
      slackSigningSecret: "unused",
      identity: { resolveParticipantId: async () => null },
      responder: { respond: async () => {} },
      auth: { store: sessions, staff: directory, orgId: ORG },
      ...(options.withService === false ? {} : { staffAdmin }),
    };
    const server = createServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ada = sessions.seed("user-ada");

    const put = (cookie: string, body: unknown) =>
      fetch(`${base}/orgs/${ORG}/staff`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const list = (cookie: string) =>
      fetch(`${base}/orgs/${ORG}/staff`, { headers: { cookie } });
    return { base, sessions, directory, staffAdmin, ada, put, list };
  }

  it("lists the org's staff for an admin", async () => {
    const { ada, list } = await listen();
    const res = await list(ada);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { userId: "user-ada", email: "ada@example.com", displayName: "Ada", role: "admin" },
    ]);
  });

  it("grants a role, naming the acting admin, and the list shows it", async () => {
    const { ada, put, list, staffAdmin } = await listen();
    const res = await put(ada, { email: " Grace@Example.com ", role: "program_lead", displayName: "Grace" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      member: { userId: "user-2", email: "grace@example.com", displayName: "Grace", role: "program_lead" },
      changed: true,
      createdUser: true,
    });
    expect(staffAdmin.changes).toEqual([
      { email: "grace@example.com", staffRole: "program_lead", actorUserId: "user-ada" },
    ]);
    const rows = (await (await list(ada)).json()) as { email: string }[];
    expect(rows.map((r) => r.email)).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("a no-op returns changed: false", async () => {
    const { ada, put, staffAdmin } = await listen();
    const res = await put(ada, { email: "ada@example.com", role: "admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false, member: { role: "admin" } });
    expect(staffAdmin.changes).toEqual([]);
  });

  it("refuses to remove the last admin — including the admin demoting themselves — with 409", async () => {
    const { ada, put, list, staffAdmin } = await listen();
    for (const role of ["none", "program_lead"]) {
      const res = await put(ada, { email: "ada@example.com", role });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "last_admin" });
    }
    expect(staffAdmin.changes).toEqual([]);
    expect((await list(ada)).status).toBe(200); // still an admin
  });

  it("with a second admin, an admin may step down", async () => {
    const { ada, put, list } = await listen();
    expect((await put(ada, { email: "bea@example.com", role: "admin" })).status).toBe(200);
    const res = await put(ada, { email: "ada@example.com", role: "none" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, member: { role: null } });
    // Live on the very next request: Ada is no longer staff at all.
    expect((await list(ada)).status).toBe(403);
  });

  it("a revoked or demoted user's next request is refused — nothing caches the role", async () => {
    const { ada, sessions, staffAdmin, put, list } = await listen();
    staffAdmin.addPerson("cy@example.com", "user-cy", "admin");
    const cy = sessions.seed("user-cy");
    expect((await list(cy)).status).toBe(200);

    expect((await put(ada, { email: "cy@example.com", role: "program_lead" })).status).toBe(200);
    expect((await list(cy)).status).toBe(403); // a lead may not manage staff
    expect((await put(ada, { email: "cy@example.com", role: "none" })).status).toBe(200);
    expect((await list(cy)).status).toBe(403);
    expect((await put(cy, { email: "cy@example.com", role: "admin" })).status).toBe(403);
  });

  it("404s revoking an email with no user here", async () => {
    const { ada, put } = await listen();
    const res = await put(ada, { email: "nobody@example.com", role: "none" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "unknown_user" });
  });

  it.each([
    ["invalid JSON", "{not json", undefined],
    ["a missing email", { role: "admin" }, "email"],
    ["a malformed email", { email: "not-an-email", role: "admin" }, "email"],
    ["a missing role", { email: "x@example.com" }, "role"],
    ["a pair role", { email: "x@example.com", role: "mentee" }, "role"],
    ["a null role (revoking is the word none)", { email: "x@example.com", role: null }, "role"],
    ["an unknown field", { email: "x@example.com", role: "admin", staffRole: "admin" }, ""],
    ["an empty name", { email: "x@example.com", role: "admin", displayName: "  " }, "displayName"],
  ])("400s %s, writing nothing", async (_label, body, field) => {
    const { ada, put, staffAdmin } = await listen();
    const res = await put(ada, body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues?: { field: string }[] };
    expect(typeof json.error).toBe("string");
    if (field !== undefined) expect(json.issues?.map((i) => i.field)).toContain(field);
    expect(staffAdmin.changes).toEqual([]);
  });

  it("501s both routes, after auth, when no staff service is wired (the in-memory main.ts)", async () => {
    const { ada, put, list } = await listen({ withService: false });
    expect((await list(ada)).status).toBe(501);
    expect((await put(ada, { email: "x@example.com", role: "admin" })).status).toBe(501);
    expect((await list("mentorship_session=nope")).status).toBe(401);
  });

  it("400s an orgId that is not a UUID", async () => {
    const { base, ada } = await listen();
    const res = await fetch(`${base}/orgs/not-a-uuid/staff`, { headers: { cookie: ada } });
    expect(res.status).toBe(400);
  });
});
