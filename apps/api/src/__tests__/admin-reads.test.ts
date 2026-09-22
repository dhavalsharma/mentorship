import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MagicLinkStore } from "@mentorship/auth";
import {
  createServer,
  notImplementedMatchingReads,
  notImplementedReads,
  type AdminListQuery,
  type AuthDeps,
  type MatchingRoundCandidatesQuery,
} from "../server.js";

/**
 * Same style as `server.test.ts`: a real socket, real HTTP requests. The
 * Slack deps (`identity`/`responder`) are never exercised by these routes,
 * so they get harmless stand-ins rather than a full seeded harness.
 *
 * These routes now require a real session (see `authenticateAdmin` in
 * `server.ts`), so every test that expects to reach the query needs a valid
 * `mentorship_session` cookie for `VALID_ORG_ID` — `sessionCookieFor` below
 * mints one against a Map-based fake `MagicLinkStore`, the same fake shape
 * `packages/auth/src/__tests__/magic-link.test.ts` uses.
 */

const VALID_ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222";

interface SessionRow {
  id: string;
  orgId: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Minimal fake — only the session half of `MagicLinkStore` is exercised here. */
class FakeMagicLinkStore implements MagicLinkStore {
  sessions = new Map<string, SessionRow>();
  private nextSessionId = 1;

  /** Test helper: skips the request/verify dance and seeds a session directly. */
  seedSession(orgId: string, userId: string): string {
    const sessionId = `sess-${this.nextSessionId++}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      orgId,
      userId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    });
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
  async createSession(input: { orgId: string; userId: string; expiresAt: string }) {
    return { sessionId: this.seedSession(input.orgId, input.userId) };
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

describe("admin read routes over a real socket", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(admin?: {
    riskFindings: AdminListQuery;
    nudges: AdminListQuery;
    matchingRoundCandidates?: MatchingRoundCandidatesQuery;
  }): Promise<{ base: string; auth: AuthDeps; store: FakeMagicLinkStore }> {
    const store = new FakeMagicLinkStore();
    const auth: AuthDeps = { store, orgId: VALID_ORG_ID };
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: noopIdentity(),
      responder: noopResponder(),
      admin: admin
        ? {
            ...admin,
            matchingRoundCandidates:
              admin.matchingRoundCandidates ?? notImplementedMatchingReads(),
          }
        : undefined,
      auth,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, auth, store };
  }

  /** A valid session, scoped to `VALID_ORG_ID`, as a `Cookie` header value. */
  function cookieFor(store: FakeMagicLinkStore): string {
    const sessionId = store.seedSession(VALID_ORG_ID, "user-1");
    return `mentorship_session=${sessionId}`;
  }

  it("lists risk findings from the injected query as JSON with a 200", async () => {
    const fake = [{ id: "f1", code: "silence", severity: "amber" }];
    const riskFindings: AdminListQuery = async (orgId, limit) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(limit).toBe(50);
      return fake;
    };
    const { base, store } = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/risk-findings`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("lists nudges from the injected query as JSON with a 200", async () => {
    const fake = [{ id: "n1", channel: "slack", state: "sent" }];
    const nudges: AdminListQuery = async (orgId, limit) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(limit).toBe(50);
      return fake;
    };
    const { base, store } = await listen({ riskFindings: notImplementedReads(), nudges });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/nudges`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("400s a non-UUID orgId before ever calling the query", async () => {
    let called = false;
    const riskFindings: AdminListQuery = async () => {
      called = true;
      return [];
    };
    const { base, store } = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(`${base}/orgs/not-a-uuid/risk-findings`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("clamps an out-of-range limit rather than passing it through", async () => {
    let seenLimit: number | undefined;
    const riskFindings: AdminListQuery = async (_orgId, limit) => {
      seenLimit = limit;
      return [];
    };
    const { base, store } = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/risk-findings?limit=999999`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(200);
    expect(seenLimit).toBe(200);
  });

  it("falls back to the default limit on a garbage limit param", async () => {
    let seenLimit: number | undefined;
    const riskFindings: AdminListQuery = async (_orgId, limit) => {
      seenLimit = limit;
      return [];
    };
    const { base, store } = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/risk-findings?limit=not-a-number`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(200);
    expect(seenLimit).toBe(50);
  });

  it("501s with a JSON body when the backend does not track the resource", async () => {
    const { base, store } = await listen({
      riskFindings: notImplementedReads(),
      nudges: notImplementedReads(),
    });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/risk-findings`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(501);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/risk-findings/);
  });

  it("501s when the server has no admin deps configured at all", async () => {
    const { base, store } = await listen(undefined);

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/nudges`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("still 404s an unrelated unknown route", async () => {
    const { base, store } = await listen(undefined);
    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/something-else`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(404);
  });

  it("401s with no session cookie at all, without ever calling the query", async () => {
    let called = false;
    const riskFindings: AdminListQuery = async () => {
      called = true;
      return [];
    };
    const { base } = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/risk-findings`);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(called).toBe(false);
  });

  it("401s an unrecognised session id, without ever calling the query", async () => {
    let called = false;
    const riskFindings: AdminListQuery = async () => {
      called = true;
      return [];
    };
    const { base } = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/risk-findings`, {
      headers: { cookie: "mentorship_session=not-a-real-session" },
    });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("403s when the session's own org does not match the URL's :orgId, without ever calling the query", async () => {
    let called = false;
    const riskFindings: AdminListQuery = async () => {
      called = true;
      return [];
    };
    // The server (and this test's fake store) is bound to VALID_ORG_ID —
    // see `listen`'s `auth: { orgId: VALID_ORG_ID }` — so a perfectly valid
    // session for that org must still be refused for a *different* org's
    // URL, per invariant 3: a session issued for one org is never usable to
    // read another's data, even when that other org's id is a real UUID.
    const { base, store } = await listen({ riskFindings, nudges: notImplementedReads() });
    const res = await fetch(`${base}/orgs/${OTHER_ORG_ID}/risk-findings`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
    expect(called).toBe(false);
  });
});

const VALID_RUN_ID = "33333333-3333-3333-3333-333333333333";

/**
 * `GET /orgs/:orgId/matching-rounds/:runId/candidates` — the appeal-UI read
 * model. Same real-socket style as the suite above; kept as its own describe
 * block because the route takes a second path segment (`runId`) the
 * risk-findings/nudges routes do not, with its own 400/404 shape.
 */
describe("matching-round candidates route over a real socket", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(
    matchingRoundCandidates?: MatchingRoundCandidatesQuery,
  ): Promise<{ base: string; store: FakeMagicLinkStore }> {
    const store = new FakeMagicLinkStore();
    const auth: AuthDeps = { store, orgId: VALID_ORG_ID };
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: noopIdentity(),
      responder: noopResponder(),
      admin: matchingRoundCandidates
        ? {
            riskFindings: notImplementedReads(),
            nudges: notImplementedReads(),
            matchingRoundCandidates,
          }
        : undefined,
      auth,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, store };
  }

  function cookieFor(store: FakeMagicLinkStore): string {
    const sessionId = store.seedSession(VALID_ORG_ID, "user-1");
    return `mentorship_session=${sessionId}`;
  }

  it("returns the candidates from the injected query as JSON with a 200", async () => {
    const fake = { runId: VALID_RUN_ID, cohortId: "coh_1", asOf: "x", createdAt: "y", candidates: [] };
    const query: MatchingRoundCandidatesQuery = async (orgId, runId) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(runId).toBe(VALID_RUN_ID);
      return fake;
    };
    const { base, store } = await listen(query);

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/matching-rounds/${VALID_RUN_ID}/candidates`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("404s when the query resolves null (no such run, or not a matching run)", async () => {
    const { base, store } = await listen(async () => null);

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/matching-rounds/${VALID_RUN_ID}/candidates`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("400s a non-UUID runId before ever calling the query", async () => {
    let called = false;
    const { base, store } = await listen(async () => {
      called = true;
      return null;
    });

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/matching-rounds/not-a-uuid/candidates`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("501s with a JSON body when the backend does not track matching rounds", async () => {
    const { base, store } = await listen(notImplementedMatchingReads());

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/matching-rounds/${VALID_RUN_ID}/candidates`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/matching rounds/);
  });

  it("501s when the server has no admin deps configured at all", async () => {
    const { base, store } = await listen(undefined);

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/matching-rounds/${VALID_RUN_ID}/candidates`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(501);
  });

  it("401s with no session cookie at all, without ever calling the query", async () => {
    let called = false;
    const { base } = await listen(async () => {
      called = true;
      return null;
    });

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/matching-rounds/${VALID_RUN_ID}/candidates`,
    );
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it("403s when the session's own org does not match the URL's :orgId, without ever calling the query", async () => {
    let called = false;
    const { base, store } = await listen(async () => {
      called = true;
      return null;
    });

    const res = await fetch(
      `${base}/orgs/${OTHER_ORG_ID}/matching-rounds/${VALID_RUN_ID}/candidates`,
      { headers: { cookie: cookieFor(store) } },
    );
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });
});
