import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  requestMagicLink,
  verifyMagicLink,
  verifySession,
  type MagicLinkStore,
} from "@mentorship/auth";

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

/** Map-based fake — no real database, mirrors the shape `PostgresMagicLinkStore` has. */
class FakeMagicLinkStore implements MagicLinkStore {
  users = new Map<string, { orgId: string; email: string; userId: string }>();
  links: LinkRow[] = [];
  sessions = new Map<string, SessionRow>();

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
    const row = this.links.find(
      (l) => l.orgId === orgId && l.tokenHash === tokenHash,
    );
    if (!row) return null;
    return {
      userId: row.userId,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    };
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
    const sessionId = randomUUID();
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
    return {
      userId: row.userId,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }
}

const ORG = "org-1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("requestMagicLink", () => {
  it("creates a link for a known email and returns a raw token whose hash matches the stored one", async () => {
    const store = new FakeMagicLinkStore();
    store.addUser(ORG, "known@example.com", "user-1");
    const now = () => new Date("2026-01-01T00:00:00Z");

    const result = await requestMagicLink({ store, orgId: ORG, email: "known@example.com", now });

    expect(result.requested).toBe(true);
    expect(result.rawToken).not.toBeNull();
    expect(store.links).toHaveLength(1);
    const link = store.links[0];
    if (!link) throw new Error("expected a link to have been created");
    expect(link.tokenHash).toBe(sha256(result.rawToken as string));
    // The raw token itself must never appear anywhere in the stored row.
    expect(link.tokenHash).not.toBe(result.rawToken);
  });

  it("does not create anything for an unknown email, but returns the same generic shape", async () => {
    const store = new FakeMagicLinkStore();
    const now = () => new Date("2026-01-01T00:00:00Z");

    const known = await requestMagicLink({
      store,
      orgId: ORG,
      email: "unknown@example.com",
      now,
    });

    expect(store.links).toHaveLength(0);
    // Enumeration safety: both outcomes share the same top-level discriminant
    // (`requested: true`) and the same key set — only `rawToken`'s value
    // differs, and a caller facing the requester is expected to discard it
    // rather than branch on it.
    expect(known.requested).toBe(true);
    expect(Object.keys(known).sort()).toEqual(["rawToken", "requested"]);
    expect(known.rawToken).toBeNull();
  });
});

describe("verifyMagicLink", () => {
  it("succeeds for a fresh token and returns a session", async () => {
    const store = new FakeMagicLinkStore();
    store.addUser(ORG, "known@example.com", "user-1");
    const now = () => new Date("2026-01-01T00:00:00Z");
    const { rawToken } = await requestMagicLink({ store, orgId: ORG, email: "known@example.com", now });

    const result = await verifyMagicLink({ store, orgId: ORG, rawToken: rawToken as string, now });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.sessionId).toBe("string");
      expect(store.sessions.has(result.sessionId)).toBe(true);
    }
  });

  it("fails the second time with already_used", async () => {
    const store = new FakeMagicLinkStore();
    store.addUser(ORG, "known@example.com", "user-1");
    const now = () => new Date("2026-01-01T00:00:00Z");
    const { rawToken } = await requestMagicLink({ store, orgId: ORG, email: "known@example.com", now });

    const first = await verifyMagicLink({ store, orgId: ORG, rawToken: rawToken as string, now });
    expect(first.ok).toBe(true);

    const second = await verifyMagicLink({ store, orgId: ORG, rawToken: rawToken as string, now });
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("fails with expired once past its ttl, via injected time rather than real sleeps", async () => {
    const store = new FakeMagicLinkStore();
    store.addUser(ORG, "known@example.com", "user-1");
    let clock = new Date("2026-01-01T00:00:00Z");
    const now = () => clock;
    const { rawToken } = await requestMagicLink({
      store,
      orgId: ORG,
      email: "known@example.com",
      now,
      ttlMinutes: 15,
    });

    clock = new Date("2026-01-01T00:20:00Z");
    const result = await verifyMagicLink({ store, orgId: ORG, rawToken: rawToken as string, now });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("fails with not_found for a garbage token", async () => {
    const store = new FakeMagicLinkStore();
    const now = () => new Date("2026-01-01T00:00:00Z");

    const result = await verifyMagicLink({ store, orgId: ORG, rawToken: "not-a-real-token", now });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("only lets one of two concurrent verifications win, even though both pass the initial lookup", async () => {
    // The store's own consumeLink is the race-safe boundary — this asserts
    // verifyMagicLink actually trusts its return value rather than the
    // earlier, non-atomic findUnconsumedLinkByTokenHash lookup.
    const store = new FakeMagicLinkStore();
    store.addUser(ORG, "known@example.com", "user-1");
    const now = () => new Date("2026-01-01T00:00:00Z");
    const { rawToken } = await requestMagicLink({ store, orgId: ORG, email: "known@example.com", now });

    const [first, second] = await Promise.all([
      verifyMagicLink({ store, orgId: ORG, rawToken: rawToken as string, now }),
      verifyMagicLink({ store, orgId: ORG, rawToken: rawToken as string, now }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.reason === "already_used")).toHaveLength(1);
  });
});

describe("verifySession", () => {
  it("succeeds for a valid, unexpired, unrevoked session", async () => {
    const store = new FakeMagicLinkStore();
    const { sessionId } = await store.createSession({
      orgId: ORG,
      userId: "user-1",
      expiresAt: "2026-01-08T00:00:00Z",
    });
    const now = () => new Date("2026-01-01T00:00:00Z");

    const result = await verifySession({ store, orgId: ORG, sessionId, now });

    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  it("fails for an expired session", async () => {
    const store = new FakeMagicLinkStore();
    const { sessionId } = await store.createSession({
      orgId: ORG,
      userId: "user-1",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    const now = () => new Date("2026-01-08T00:00:00Z");

    const result = await verifySession({ store, orgId: ORG, sessionId, now });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("fails for a revoked session", async () => {
    const store = new FakeMagicLinkStore();
    const { sessionId } = await store.createSession({
      orgId: ORG,
      userId: "user-1",
      expiresAt: "2026-01-08T00:00:00Z",
    });
    const session = store.sessions.get(sessionId);
    if (session) session.revokedAt = "2026-01-02T00:00:00Z";
    const now = () => new Date("2026-01-03T00:00:00Z");

    const result = await verifySession({ store, orgId: ORG, sessionId, now });

    expect(result).toEqual({ ok: false, reason: "revoked" });
  });
});
