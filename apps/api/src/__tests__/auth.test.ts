import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeStaffDirectory } from "./staff-fake.js";
import type { MagicLinkStore } from "@mentorship/auth";
import { createServer, type ApiServerDeps } from "../server.js";

/**
 * Same real-socket style as `server.test.ts` / `admin-reads.test.ts`. A
 * Map-based fake `MagicLinkStore` — mirrors
 * `packages/auth/src/__tests__/magic-link.test.ts`'s `FakeMagicLinkStore` —
 * stands in for Postgres, since these tests exercise the HTTP wiring
 * (`server.ts`'s new routes), not `packages/auth` itself.
 */

const ORG_ID = "org-1";

interface LinkRow {
  orgId: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
}

interface SessionRow {
  id: string;
  orgId: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

class FakeMagicLinkStore implements MagicLinkStore {
  users = new Map<string, { orgId: string; email: string; userId: string }>();
  links: LinkRow[] = [];
  sessions = new Map<string, SessionRow>();
  private nextSessionId = 1;

  addUser(orgId: string, email: string, userId: string): void {
    this.users.set(`${orgId}:${email}`, { orgId, email, userId });
  }

  async findUserByEmail(orgId: string, email: string) {
    const row = this.users.get(`${orgId}:${email}`);
    return row ? { userId: row.userId } : null;
  }

  async createLink(input: {
    orgId: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void> {
    this.links.push({ ...input, consumedAt: null });
  }

  async findUnconsumedLinkByTokenHash(orgId: string, tokenHash: string) {
    const row = this.links.find((l) => l.orgId === orgId && l.tokenHash === tokenHash);
    if (!row) return null;
    return { userId: row.userId, expiresAt: row.expiresAt, consumedAt: row.consumedAt };
  }

  async consumeLink(orgId: string, tokenHash: string): Promise<boolean> {
    const row = this.links.find(
      (l) => l.orgId === orgId && l.tokenHash === tokenHash && l.consumedAt === null,
    );
    if (!row) return false;
    row.consumedAt = new Date().toISOString();
    return true;
  }

  async createSession(input: { orgId: string; userId: string; expiresAt: string }) {
    const sessionId = `sess-${this.nextSessionId++}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      orgId: input.orgId,
      userId: input.userId,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    return { sessionId };
  }

  async findActiveSession(orgId: string, sessionId: string) {
    const row = this.sessions.get(sessionId);
    if (!row || row.orgId !== orgId) return null;
    return { userId: row.userId, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  }
}

function noopIdentity() {
  return { resolveParticipantId: async () => null };
}

function noopResponder() {
  return { respond: async () => {} };
}

describe("magic-link auth routes over a real socket", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(overrides?: Partial<ApiServerDeps>): Promise<{
    base: string;
    store: FakeMagicLinkStore;
    issued: { email: string; rawToken: string }[];
  }> {
    const store = new FakeMagicLinkStore();
    const issued: { email: string; rawToken: string }[] = [];
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: noopIdentity(),
      responder: noopResponder(),
      auth: {
        store,
        staff: new FakeStaffDirectory("admin"),
        orgId: ORG_ID,
        onMagicLinkIssued: (email, rawToken) => issued.push({ email, rawToken }),
      },
      ...overrides,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, store, issued };
  }

  describe("POST /auth/request-link", () => {
    it("returns the identical response shape and status for a known and an unknown email", async () => {
      const { base, store, issued } = await listen();
      store.addUser(ORG_ID, "known@example.com", "user-1");

      const knownRes = await fetch(`${base}/auth/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "known@example.com" }),
      });
      const unknownRes = await fetch(`${base}/auth/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com" }),
      });

      // The security property that matters: status and body are
      // indistinguishable, so a caller cannot tell which email exists.
      expect(knownRes.status).toBe(unknownRes.status);
      expect(knownRes.status).toBe(200);
      const knownBody = await knownRes.json();
      const unknownBody = await unknownRes.json();
      expect(knownBody).toEqual({ requested: true });
      expect(unknownBody).toEqual({ requested: true });
      expect(knownBody).toEqual(unknownBody);

      // The raw token exists only for the known email, but only reaches the
      // server-side observability seam — never the HTTP response above.
      expect(issued).toHaveLength(1);
      expect(issued[0]!.email).toBe("known@example.com");
    });

    it("400s a request with no email, before touching the store", async () => {
      const { base } = await listen();
      const res = await fetch(`${base}/auth/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("501s when auth is not configured on this server", async () => {
      const server = createServer({
        slackSigningSecret: "test-signing-secret",
        identity: noopIdentity(),
        responder: noopResponder(),
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      close = () => server.close();
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/auth/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@example.com" }),
      });
      expect(res.status).toBe(501);
    });
  });

  describe("POST /auth/verify", () => {
    it("sets a session cookie and returns 200 for a valid token", async () => {
      const { base, store, issued } = await listen();
      store.addUser(ORG_ID, "known@example.com", "user-1");
      await fetch(`${base}/auth/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "known@example.com" }),
      });
      const rawToken = issued[0]!.rawToken;

      const res = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toMatch(/^mentorship_session=/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      // Requested from 127.0.0.1 in this test, which is treated as
      // localhost — see `buildSessionCookie`'s doc comment in server.ts.
      expect(setCookie).not.toMatch(/Secure/);
    });

    it("401s an unknown token with reason not_found", async () => {
      const { base } = await listen();
      const res = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "does-not-exist" }),
      });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ ok: false, reason: "not_found" });
    });

    it("401s a token that was already used with reason already_used", async () => {
      const { base, store, issued } = await listen();
      store.addUser(ORG_ID, "known@example.com", "user-1");
      await fetch(`${base}/auth/request-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "known@example.com" }),
      });
      const rawToken = issued[0]!.rawToken;

      const first = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      });
      expect(second.status).toBe(401);
      await expect(second.json()).resolves.toEqual({
        ok: false,
        reason: "already_used",
      });
    });
  });
});
