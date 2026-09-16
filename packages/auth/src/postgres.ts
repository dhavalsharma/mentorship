import { and, eq, isNull } from "drizzle-orm";
import {
  authSessions,
  magicLinks,
  users,
  withTenant,
  type Db,
} from "@mentorship/db";
import type { MagicLinkStore } from "./magic-link.js";

/**
 * `magic_links` and `auth_sessions`, backing `MagicLinkStore` — the Postgres
 * counterpart to a `FakeMagicLinkStore` in tests, same constructor shape as
 * `PostgresRiskFindingsSink` / `PostgresAiRunSink`.
 */
export class PostgresMagicLinkStore implements MagicLinkStore {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  private run<T>(orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    const { role } = this.options;
    return withTenant(this.db, orgId, fn, role === undefined ? {} : { role });
  }

  async findUserByEmail(
    orgId: string,
    email: string,
  ): Promise<{ userId: string } | null> {
    return this.run(orgId, async (tx) => {
      const [row] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.email, email)))
        .limit(1);
      return row ? { userId: row.id } : null;
    });
  }

  async createLink(input: {
    orgId: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void> {
    await this.run(input.orgId, async (tx) => {
      await tx.insert(magicLinks).values({
        orgId: input.orgId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: new Date(input.expiresAt),
      });
    });
  }

  async findUnconsumedLinkByTokenHash(
    orgId: string,
    tokenHash: string,
  ): Promise<{ userId: string; expiresAt: string; consumedAt: string | null } | null> {
    return this.run(orgId, async (tx) => {
      const [row] = await tx
        .select({
          userId: magicLinks.userId,
          expiresAt: magicLinks.expiresAt,
          consumedAt: magicLinks.consumedAt,
        })
        .from(magicLinks)
        .where(and(eq(magicLinks.orgId, orgId), eq(magicLinks.tokenHash, tokenHash)))
        .limit(1);
      if (!row) return null;
      return {
        userId: row.userId,
        expiresAt: row.expiresAt.toISOString(),
        consumedAt: row.consumedAt?.toISOString() ?? null,
      };
    });
  }

  async consumeLink(orgId: string, tokenHash: string): Promise<boolean> {
    return this.run(orgId, async (tx) => {
      // The `consumed_at IS NULL` guard makes this atomic: only the request
      // that actually flips the row gets a row back from `.returning()`, so
      // a concurrent replay of the same link sees an empty result here even
      // though it may have passed an earlier, non-atomic lookup.
      const rows = await tx
        .update(magicLinks)
        .set({ consumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(magicLinks.orgId, orgId),
            eq(magicLinks.tokenHash, tokenHash),
            isNull(magicLinks.consumedAt),
          ),
        )
        .returning({ id: magicLinks.id });
      return rows.length > 0;
    });
  }

  async createSession(input: {
    orgId: string;
    userId: string;
    expiresAt: string;
  }): Promise<{ sessionId: string }> {
    return this.run(input.orgId, async (tx) => {
      const [row] = await tx
        .insert(authSessions)
        .values({
          orgId: input.orgId,
          userId: input.userId,
          expiresAt: new Date(input.expiresAt),
        })
        .returning({ id: authSessions.id });
      if (!row) throw new Error("failed to create auth session");
      return { sessionId: row.id };
    });
  }

  async findActiveSession(
    orgId: string,
    sessionId: string,
  ): Promise<{ userId: string; expiresAt: string; revokedAt: string | null } | null> {
    return this.run(orgId, async (tx) => {
      const [row] = await tx
        .select({
          userId: authSessions.userId,
          expiresAt: authSessions.expiresAt,
          revokedAt: authSessions.revokedAt,
        })
        .from(authSessions)
        .where(and(eq(authSessions.orgId, orgId), eq(authSessions.id, sessionId)))
        .limit(1);
      if (!row) return null;
      return {
        userId: row.userId,
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      };
    });
  }
}
