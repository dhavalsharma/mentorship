import { and, eq } from "drizzle-orm";
import { aiRuns, withTenant, type Db } from "@mentorship/db";
import type { AiRunRecord, AiRunSink } from "./run.js";

/**
 * `ai_runs`, written before the first real model call rather than retrofitted.
 * Retrofitting it means you can never answer "did v4 help?" about anything
 * that already shipped.
 */
export class PostgresAiRunSink implements AiRunSink {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  async record(run: AiRunRecord): Promise<void> {
    const { role } = this.options;
    await withTenant(
      this.db,
      run.orgId,
      async (tx) => {
        await tx.insert(aiRuns).values({
          orgId: run.orgId,
          primitive: run.primitive,
          promptVersion: run.promptVersion,
          model: run.model,
          inputHash: run.inputHash,
          input: run.input ?? null,
          output: run.output ?? null,
          tokensIn: run.tokensIn ?? null,
          tokensOut: run.tokensOut ?? null,
          // numeric columns take a string through drizzle.
          costUsd: run.costUsd === undefined ? null : String(run.costUsd),
          latencyMs: run.latencyMs ?? null,
          error: run.error ?? null,
          subjectId: run.subjectId ?? null,
        });
      },
      role === undefined ? {} : { role },
    );
  }

  /** Invariant 19/20: the confirm/edit tap becomes the eval label, in place. */
  async setVerdict(input: {
    orgId: string;
    subjectId: string;
    verdict: string;
  }): Promise<void> {
    const { role } = this.options;
    await withTenant(
      this.db,
      input.orgId,
      async (tx) => {
        await tx
          .update(aiRuns)
          .set({ verdict: input.verdict })
          .where(
            and(
              eq(aiRuns.orgId, input.orgId),
              eq(aiRuns.subjectId, input.subjectId),
            ),
          );
      },
      role === undefined ? {} : { role },
    );
  }
}
