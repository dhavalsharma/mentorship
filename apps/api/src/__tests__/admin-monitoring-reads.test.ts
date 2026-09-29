import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeStaffDirectory } from "./staff-fake.js";
import type { MagicLinkStore } from "@mentorship/auth";
import {
  createServer,
  notImplementedMatchingReads,
  notImplementedPairPreferenceReads,
  notImplementedReads,
  type AdminListQuery,
  type AuthDeps,
  type StuckSagaQuery,
} from "../server.js";

/**
 * The two ROADMAP phase 1 monitoring routes: `/orgs/:orgId/stuck-sagas` and
 * `/orgs/:orgId/dead-letters`. Same shape as `admin-reads.test.ts` — a real
 * socket, a real session cookie, an injected query — kept in its own file
 * since these two routes have their own quirks worth naming: `stuck-sagas`
 * takes an extra `?days=` and 501s independently of `dead-letters`.
 */

const VALID_ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222";

class FakeMagicLinkStore implements MagicLinkStore {
  sessions = new Map<string, { orgId: string; userId: string }>();
  private nextSessionId = 1;

  seedSession(orgId: string, userId: string): string {
    const sessionId = `sess-${this.nextSessionId++}`;
    this.sessions.set(sessionId, { orgId, userId });
    return sessionId;
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

function noopIdentity() {
  return { resolveParticipantId: async () => null };
}

function noopResponder() {
  return { respond: async () => {} };
}

describe("stuck-sagas and dead-letters routes over a real socket", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(admin?: {
    stuckSagas: StuckSagaQuery;
    deadLetters: AdminListQuery;
  }): Promise<{ base: string; store: FakeMagicLinkStore }> {
    const store = new FakeMagicLinkStore();
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: noopIdentity(),
      responder: noopResponder(),
      admin: admin
        ? {
            riskFindings: notImplementedReads(),
            nudges: notImplementedReads(),
            matchingRoundCandidates: notImplementedMatchingReads(),
            pairPreferenceChanges: notImplementedPairPreferenceReads(),
            ...admin,
          }
        : undefined,
      auth: { store, staff: new FakeStaffDirectory("admin"), orgId: VALID_ORG_ID },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, store };
  }

  function cookieFor(store: FakeMagicLinkStore): string {
    return `mentorship_session=${store.seedSession(VALID_ORG_ID, "user-1")}`;
  }

  it("lists stuck sagas from the injected query, defaulting days to 3", async () => {
    const fake = [{ id: "s1", sagaName: "SessionLifecycle", status: "running" }];
    const stuckSagas: StuckSagaQuery = async (orgId, limit, days) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(limit).toBe(50);
      expect(days).toBe(3);
      return fake;
    };
    const { base, store } = await listen({ stuckSagas, deadLetters: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/stuck-sagas`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("passes a ?days= override through to the query", async () => {
    let seenDays: number | undefined;
    const stuckSagas: StuckSagaQuery = async (_orgId, _limit, days) => {
      seenDays = days;
      return [];
    };
    const { base, store } = await listen({ stuckSagas, deadLetters: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/stuck-sagas?days=14`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    expect(seenDays).toBe(14);
  });

  it("clamps an out-of-range ?days= rather than passing it through", async () => {
    let seenDays: number | undefined;
    const stuckSagas: StuckSagaQuery = async (_orgId, _limit, days) => {
      seenDays = days;
      return [];
    };
    const { base, store } = await listen({ stuckSagas, deadLetters: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/stuck-sagas?days=999999`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    expect(seenDays).toBe(90);
  });

  it("falls back to the default days on a garbage ?days=", async () => {
    let seenDays: number | undefined;
    const stuckSagas: StuckSagaQuery = async (_orgId, _limit, days) => {
      seenDays = days;
      return [];
    };
    const { base, store } = await listen({ stuckSagas, deadLetters: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/stuck-sagas?days=not-a-number`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    expect(seenDays).toBe(3);
  });

  it("lists dead letters from the injected query as JSON with a 200", async () => {
    const fake = [{ id: "e1", name: "pair.activated", lastError: "boom" }];
    const deadLetters: AdminListQuery = async (orgId, limit) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(limit).toBe(50);
      return fake;
    };
    const { base, store } = await listen({ stuckSagas: notImplementedReads(), deadLetters });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/dead-letters`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("501s stuck-sagas with a JSON body when the backend does not track it", async () => {
    const { base, store } = await listen({
      stuckSagas: notImplementedReads(),
      deadLetters: notImplementedReads(),
    });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/stuck-sagas`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/stuck-sagas/);
  });

  it("501s dead-letters when no admin deps are configured at all", async () => {
    const { base, store } = await listen(undefined);

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/dead-letters`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(501);
  });

  it("401s stuck-sagas with no session cookie, without ever calling the query", async () => {
    let called = false;
    const stuckSagas: StuckSagaQuery = async () => {
      called = true;
      return [];
    };
    const { base } = await listen({ stuckSagas, deadLetters: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/stuck-sagas`);
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("403s dead-letters when the session's own org does not match the URL's :orgId", async () => {
    let called = false;
    const deadLetters: AdminListQuery = async () => {
      called = true;
      return [];
    };
    const { base, store } = await listen({ stuckSagas: notImplementedReads(), deadLetters });

    const res = await fetch(`${base}/orgs/${OTHER_ORG_ID}/dead-letters`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("400s a non-UUID orgId before ever calling the query", async () => {
    let called = false;
    const stuckSagas: StuckSagaQuery = async () => {
      called = true;
      return [];
    };
    const { base, store } = await listen({ stuckSagas, deadLetters: notImplementedReads() });

    const res = await fetch(`${base}/orgs/not-a-uuid/stuck-sagas`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});
