import { and, desc, eq, isNull } from "drizzle-orm";
import { nudges, riskFindings, withTenant, type Db } from "@mentorship/db";

/**
 * Read-side queries for the admin GET routes. Deliberately separate from
 * `postgres-ports.ts`: those are the write ports the Slack route needs at
 * request time, these are read-only projections for an eventual dashboard.
 * Kept in `apps/api` rather than on the primitive sinks that write these
 * tables — the sinks are write-only by design; a read path belongs to the
 * surface that serves it.
 */

/**
 * `limit` arrives already clamped by the caller (`server.ts`'s route
 * matcher) — these functions trust it rather than re-validating, since the
 * HTTP-facing bound belongs with the other query-param handling.
 */

/** Open risk findings for an org — `requiresHuman` and not yet acknowledged, most recent first. */
export async function listOpenRiskFindings(
  db: Db,
  orgId: string,
  limit: number,
  role?: string,
): Promise<unknown[]> {
  return withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select()
        .from(riskFindings)
        .where(
          and(
            eq(riskFindings.orgId, orgId),
            eq(riskFindings.requiresHuman, true),
            isNull(riskFindings.acknowledgedAt),
          ),
        )
        .orderBy(desc(riskFindings.detectedAt))
        .limit(limit),
    role === undefined ? {} : { role },
  );
}

/** Recent nudge records for an org, most recently created first. */
export async function listRecentNudges(
  db: Db,
  orgId: string,
  limit: number,
  role?: string,
): Promise<unknown[]> {
  return withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select()
        .from(nudges)
        .where(eq(nudges.orgId, orgId))
        .orderBy(desc(nudges.createdAt))
        .limit(limit),
    role === undefined ? {} : { role },
  );
}
