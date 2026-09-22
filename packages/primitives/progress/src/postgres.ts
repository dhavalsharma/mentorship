import { and, eq, inArray } from "drizzle-orm";
import {
  StoredProgramPolicySchema,
  resolveCadence,
  type ProgramPolicy,
} from "@mentorship/core";
import {
  actionItems,
  cohorts,
  goalCheckins,
  goals,
  pairings,
  programs,
  riskFindings,
  sessions,
  withTenant,
  type Db,
} from "@mentorship/db";
import { PairObservationsSchema, type PairObservations } from "./observations.js";
import type { ProgressReader, ProgressTrigger } from "./primitive.js";
import type { RiskFinding } from "./risk.js";
import type { RiskFindingsSink } from "./sweep.js";

/**
 * `risk_findings`, one row per finding. Not a queue — the queue this feeds
 * does not exist yet (no admin view, no acknowledgement flow) — so this is
 * deliberately just a durable, queryable log, the same honest half-measure
 * `ai_runs` was before `packages/ai` had anything else to write.
 */
export class PostgresRiskFindingsSink implements RiskFindingsSink {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  async record(input: { orgId: string; pairingId: string; finding: RiskFinding }): Promise<void> {
    const { role } = this.options;
    await withTenant(
      this.db,
      input.orgId,
      async (tx) => {
        await tx.insert(riskFindings).values({
          orgId: input.orgId,
          pairingId: input.pairingId,
          code: input.finding.code,
          severity: input.finding.severity,
          detectedAt: new Date(input.finding.detectedAt),
          summary: input.finding.summary,
          requiresHuman: input.finding.requiresHuman,
          evidence: input.finding.evidence,
        });
      },
      role === undefined ? {} : { role },
    );
  }
}

/**
 * One resolved-policy group of active pairings, the unit `runProgressSweep`
 * (and `runNudgeSweep`, in the nudge package's own `postgres.ts`) actually
 * wants: both take a single `policy: ProgramPolicy` per call, and policy is
 * per-cohort data (ADR-0001), not per-org. Grouping by cohort is what keeps
 * a scheduler honest about that — one call per cohort rather than one call
 * per org with somebody else's cohort's weights silently applied.
 */
export interface CohortPairingGroup {
  cohortId: string;
  policy: ProgramPolicy;
  pairingIds: string[];
}

/**
 * Every active pairing in the org, grouped by the cohort (and therefore the
 * policy) it belongs to. A malformed stored policy fails loudly for that one
 * cohort rather than defaulting silently — the same discipline
 * `PostgresSagaResolvers.pairContext` already applies (see CLAUDE.md's roadmap
 * note on `StoredProgramPolicySchema`).
 */
export async function listActivePairingsByCohort(
  db: Db,
  orgId: string,
  options: { role?: string; onWarn?: (message: string, detail?: Record<string, unknown>) => void } = {},
): Promise<CohortPairingGroup[]> {
  const { role, onWarn } = options;
  return withTenant(
    db,
    orgId,
    async (tx) => {
      const rows = await tx
        .select({ pairingId: pairings.id, cohortId: pairings.cohortId })
        .from(pairings)
        .where(and(eq(pairings.orgId, orgId), eq(pairings.state, "active")));

      const byCohort = new Map<string, string[]>();
      for (const row of rows) {
        const list = byCohort.get(row.cohortId) ?? [];
        list.push(row.pairingId);
        byCohort.set(row.cohortId, list);
      }

      // One batched query for every cohort's policy rather than one round
      // trip per cohort inside the loop below — this runs on every scheduled
      // sweep tick, so an org with many cohorts otherwise pays N sequential
      // queries per tick for data a single `inArray` fetches at once.
      const cohortIds = [...byCohort.keys()];
      const policyRows =
        cohortIds.length === 0
          ? []
          : await tx
              .select({ cohortId: cohorts.id, policy: programs.policy })
              .from(cohorts)
              .innerJoin(
                programs,
                and(eq(programs.orgId, cohorts.orgId), eq(programs.id, cohorts.programId)),
              )
              .where(and(eq(cohorts.orgId, orgId), inArray(cohorts.id, cohortIds)));
      const policyByCohort = new Map(policyRows.map((r) => [r.cohortId, r.policy]));

      const groups: CohortPairingGroup[] = [];
      for (const [cohortId, pairingIds] of byCohort) {
        const rawPolicy = policyByCohort.get(cohortId);
        if (rawPolicy === undefined) {
          onWarn?.("cohort has no program/policy — skipped from this sweep", { cohortId });
          continue;
        }
        try {
          const policy = StoredProgramPolicySchema.parse(rawPolicy);
          groups.push({ cohortId, policy, pairingIds });
        } catch (err) {
          onWarn?.("cohort policy is malformed — skipped from this sweep", {
            cohortId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return groups;
    },
    role === undefined ? {} : { role },
  );
}

/**
 * `ProgressReader` over the real tables.
 *
 * Deliberately narrower than `PairObservations` allows: `activity`,
 * `mentorPortfolio` and `responseLatencies` stay empty arrays because nothing
 * in the schema records them yet (no per-message activity log, no
 * response-latency capture), and `surveys` stays empty because there is no
 * survey table (see the nudge package's own reader for the identical gap).
 * Health and risk both treat an absent contributor as "not observed" rather
 * than zero (ADR-0007), so this degrades the confidence of a composite
 * rather than lying about it — the honest version of "not built yet".
 */
export class PostgresProgressReader implements ProgressReader {
  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly options: { role?: string; now?: () => Date } = {},
  ) {}

  async observations(trigger: ProgressTrigger): Promise<PairObservations> {
    const { orgId } = this;
    const { role } = this.options;
    const asOf = trigger.asOf ?? (this.options.now ?? (() => new Date()))().toISOString();

    return withTenant(
      this.db,
      orgId,
      async (tx) => {
        const [pairing] = await tx
          .select()
          .from(pairings)
          .where(and(eq(pairings.orgId, orgId), eq(pairings.id, trigger.pairingId)))
          .limit(1);
        if (!pairing) throw new Error(`unknown pairing ${trigger.pairingId}`);

        const [policyRow] = await tx
          .select({ policy: programs.policy, cadenceOverride: cohorts.cadenceOverride })
          .from(cohorts)
          .innerJoin(
            programs,
            and(eq(programs.orgId, cohorts.orgId), eq(programs.id, cohorts.programId)),
          )
          .where(and(eq(cohorts.orgId, orgId), eq(cohorts.id, pairing.cohortId)))
          .limit(1);
        if (!policyRow) throw new Error(`pairing ${trigger.pairingId} has no cohort or program`);
        const policy = StoredProgramPolicySchema.parse(policyRow.policy);
        const cadence = resolveCadence(
          policy.cadence,
          policyRow.cadenceOverride as Partial<typeof policy.cadence> | null,
          pairing.cadenceOverride as Partial<typeof policy.cadence> | null,
        );

        const sessionRows = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.orgId, orgId), eq(sessions.pairingId, trigger.pairingId)));

        const actionItemRows = await tx
          .select()
          .from(actionItems)
          .where(and(eq(actionItems.orgId, orgId), eq(actionItems.pairingId, trigger.pairingId)));

        const goalRows = await tx
          .select()
          .from(goals)
          .where(and(eq(goals.orgId, orgId), eq(goals.pairingId, trigger.pairingId)));

        const goalIds = goalRows.map((g) => g.id);
        const checkinRows =
          goalIds.length === 0
            ? []
            : await tx
                .select()
                .from(goalCheckins)
                .where(and(eq(goalCheckins.orgId, orgId), inArray(goalCheckins.goalId, goalIds)));

        const nextSession = sessionRows
          .filter((s) => s.state === "scheduled" && s.startsAt.getTime() > Date.parse(asOf))
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];

        const observations: PairObservations = {
          orgId,
          pairingId: trigger.pairingId,
          asOf,
          // No dedicated "activated at" column — `createdAt` is the closest
          // durable proxy the schema has today. Flagged here rather than
          // silently treated as exact.
          startedAt: pairing.createdAt.toISOString(),
          policy,
          cadence,
          participantCount: 2,
          sessions: sessionRows.map((s) => ({
            sessionId: s.id,
            at: s.startsAt.toISOString(),
            outcome: s.state === "cancelled" ? "cancelled" : s.state === "no_show" ? "no_show" : "held",
          })),
          actionItems: actionItemRows.map((a) => ({
            id: a.id,
            createdAt: a.createdAt.toISOString(),
            closedAt: a.state === "done" ? a.updatedAt.toISOString() : null,
            dueAt: a.dueAt?.toISOString() ?? null,
          })),
          goals: goalRows.map((g) => ({
            goalId: g.id,
            openedAt: g.createdAt.toISOString(),
            targetAt: g.horizonAt?.toISOString() ?? null,
            checkIns: checkinRows
              .filter((c) => c.goalId === g.id)
              .map((c) => ({
                at: c.createdAt.toISOString(),
                // Written from `GoalDirectionSchema` (session-intel's shape,
                // the only producer of goal check-ins today): "advanced" /
                // "blocked" / "unchanged" / "abandoned", normalised to 0..1.
                progress:
                  c.direction === "advanced"
                    ? 1
                    : c.direction === "blocked" || c.direction === "abandoned"
                      ? 0
                      : 0.5,
              })),
          })),
          activity: [],
          surveys: [],
          responseLatencies: [],
          nextSessionAt: nextSession ? nextSession.startsAt.toISOString() : null,
          mentorPortfolio: [],
        };

        return PairObservationsSchema.parse(observations);
      },
      role === undefined ? {} : { role },
    );
  }
}
