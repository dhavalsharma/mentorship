import { riskFindings, withTenant, type Db } from "@mentorship/db";
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
