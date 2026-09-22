import { and, eq, gte } from "drizzle-orm";
import type { EventSink } from "@mentorship/events";
import { nudges, riskFindings, withTenant, type Db } from "@mentorship/db";

/**
 * The scheduled digest.
 *
 * There is no real notification channel wired for a digest yet — no email,
 * no Slack summary, nothing an admin actually reads on a cadence. Rather than
 * silently no-op (or worse, invent a fake email adapter), this computes a
 * real summary from the two read models that already exist —
 * `risk_findings` and `nudges` — over the trailing window, and persists it
 * durably as a `digest.computed` domain event: the outbox row a future
 * notification channel can subscribe to, exactly the way every other
 * automated action in this system already leaves a before-and-after record.
 * "Digest" today means *compute-and-persist a summary*, not *send a message*
 * — a future channel is what turns this event into an actual digest someone
 * reads.
 */

export interface DigestSummary {
  windowStart: string;
  windowEnd: string;
  riskFindings: {
    total: number;
    requiresHuman: number;
    bySeverity: Record<string, number>;
  };
  nudges: {
    total: number;
    sent: number;
    dropped: number;
    planned: number;
  };
}

export interface DigestRow {
  createdAt: Date;
}

export interface RiskFindingDigestRow extends DigestRow {
  severity: string;
  requiresHuman: boolean;
}

export interface NudgeDigestRow extends DigestRow {
  state: "planned" | "sent" | "dropped";
}

/**
 * Pure — no database, no clock of its own. Takes the rows already filtered to
 * the window and counts them. Kept separate from the Postgres query so the
 * arithmetic is testable without `DATABASE_URL`, the same split every other
 * sweep in this codebase makes (`sweep()` in `deficits.ts` is the model).
 */
export function summarizeDigest(input: {
  windowStart: string;
  windowEnd: string;
  riskFindingRows: RiskFindingDigestRow[];
  nudgeRows: NudgeDigestRow[];
}): DigestSummary {
  const bySeverity: Record<string, number> = {};
  let requiresHuman = 0;
  for (const row of input.riskFindingRows) {
    bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1;
    if (row.requiresHuman) requiresHuman++;
  }

  let sent = 0;
  let dropped = 0;
  let planned = 0;
  for (const row of input.nudgeRows) {
    if (row.state === "sent") sent++;
    else if (row.state === "dropped") dropped++;
    else planned++;
  }

  return {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    riskFindings: {
      total: input.riskFindingRows.length,
      requiresHuman,
      bySeverity,
    },
    nudges: { total: input.nudgeRows.length, sent, dropped, planned },
  };
}

export interface DigestSweepOptions {
  db: Db;
  orgId: string;
  sink: EventSink;
  /** How far back the window reaches. Defaults to 24 hours. */
  windowMs?: number;
  role?: string;
  now?: () => Date;
}

/**
 * Queries `risk_findings` and `nudges` for the window, computes the summary,
 * and emits it as a `digest.computed` event scoped to `orgId` — the unit
 * `Scheduler` calls on an interval.
 */
export async function runDigestSweep(options: DigestSweepOptions): Promise<DigestSummary> {
  const now = (options.now ?? (() => new Date()))();
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const windowStartDate = new Date(now.getTime() - windowMs);
  const { role } = options;

  const { riskFindingRows, nudgeRows } = await withTenant(
    options.db,
    options.orgId,
    async (tx) => {
      const riskRows = await tx
        .select({
          createdAt: riskFindings.createdAt,
          severity: riskFindings.severity,
          requiresHuman: riskFindings.requiresHuman,
        })
        .from(riskFindings)
        .where(and(eq(riskFindings.orgId, options.orgId), gte(riskFindings.createdAt, windowStartDate)));

      const nudgeRows = await tx
        .select({ createdAt: nudges.createdAt, state: nudges.state })
        .from(nudges)
        .where(and(eq(nudges.orgId, options.orgId), gte(nudges.createdAt, windowStartDate)));

      return { riskFindingRows: riskRows, nudgeRows };
    },
    role === undefined ? {} : { role },
  );

  const summary = summarizeDigest({
    windowStart: windowStartDate.toISOString(),
    windowEnd: now.toISOString(),
    riskFindingRows: riskFindingRows.map((r) => ({
      createdAt: r.createdAt,
      severity: r.severity,
      requiresHuman: r.requiresHuman,
    })),
    nudgeRows: nudgeRows.map((r) => ({
      createdAt: r.createdAt,
      state: r.state as NudgeDigestRow["state"],
    })),
  });

  await options.sink.emit({
    orgId: options.orgId,
    name: "digest.computed",
    subjectRef: `org:${options.orgId}`,
    payload: summary as unknown as Record<string, unknown>,
  });

  return summary;
}
