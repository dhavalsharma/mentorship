import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { LlmProvider } from "@mentorship/core";
import type { AiRunSink } from "@mentorship/ai";
import { identityLinks, nudges, participants, withTenant, type Db } from "@mentorship/db";
import type { DmAdapter } from "@mentorship/core";
import type { IntegrationRegistry } from "@mentorship/integrations";
import { runProgressSweep, type ProgressSweepEntry } from "@mentorship/primitive-progress";
import {
  PostgresProgressReader,
  PostgresRiskFindingsSink,
  listActivePairingsByCohort,
} from "@mentorship/primitive-progress/postgres";
import { runNudgeSweep, sweep, type NudgeDispatchSink, type NudgeSweepEntry } from "@mentorship/primitive-nudge";
import {
  PostgresNudgeRecordSink,
  PostgresNudgeReader,
  listCohortDeficitInputs,
} from "@mentorship/primitive-nudge/postgres";

/**
 * Assembles `runProgressSweep` / `runNudgeSweep` against real Postgres data
 * and a real dispatch channel, one call per cohort (policy is per-cohort
 * data — see the grouping helpers' own comments in each primitive's
 * `postgres.ts`). This is the "wiring point" `apps/worker/src/worker.ts`
 * already has a name for with `createPrimitiveSessionIntel`: assembly lives
 * here, in the one layer allowed to depend on both the primitive and the
 * integration registry, so neither package has to import the other
 * (invariant 1, extended — see `packages/primitives/nudge/src/sweep.ts`'s
 * own note on why `NudgeDispatchSink` is declared locally rather than
 * imported from `@mentorship/integrations`).
 */

export interface SweepDeps {
  db: Db;
  orgId: string;
  registry: IntegrationRegistry;
  role?: string;
  llm?: LlmProvider;
  runs?: AiRunSink;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
  now?: () => Date;
}

/**
 * A stub that satisfies `LlmProvider` but is never actually called: passed
 * only alongside `inferenceEnabled: false`, which makes `runPrimitive`
 * degrade to the deterministic fallback before touching `.structured()` —
 * the same shape `heuristicSessionIntel` gives session intelligence when no
 * `llm` is configured for that primitive either.
 */
const NO_LLM: LlmProvider = {
  model: "none",
  async structured() {
    throw new Error("no LlmProvider configured for this sweep");
  },
};

export function createProgressSweepRunner(deps: SweepDeps): () => Promise<ProgressSweepEntry[]> {
  const reader = new PostgresProgressReader(deps.db, deps.orgId, {
    ...(deps.role === undefined ? {} : { role: deps.role }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const sink = new PostgresRiskFindingsSink(deps.db, deps.role === undefined ? {} : { role: deps.role });

  return async () => {
    const groups = await listActivePairingsByCohort(deps.db, deps.orgId, {
      ...(deps.role === undefined ? {} : { role: deps.role }),
      ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    });

    const entries: ProgressSweepEntry[] = [];
    for (const group of groups) {
      if (group.pairingIds.length === 0) continue;
      const result = await runProgressSweep({
        pairingIds: group.pairingIds,
        reader,
        llm: deps.llm ?? NO_LLM,
        policy: group.policy,
        orgId: deps.orgId,
        sink,
        ...(deps.runs ? { runs: deps.runs } : {}),
        ...(deps.llm ? {} : { inferenceEnabled: false }),
        ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
      });
      entries.push(...result.entries);
    }
    return entries;
  };
}

/**
 * Resolves a participant to a verified chat member and sends over whichever
 * DM adapter is bound, mirroring `PostgresSagaResolvers.pairContext`'s own
 * "a verified link or nothing" rule — an unverified or absent link means the
 * nudge is skipped rather than guessed at, because misdelivering into the
 * wrong person's DM is worse than a quiet drop.
 *
 * The idempotency key is derived from the message itself (recipient +
 * channel + body) rather than the sweep's own `dedupeKey`: `NudgeDispatchSink`
 * (declared in the nudge package to keep the dependency direction one-way)
 * does not carry it through to `send()`. That is a real, if narrow, gap
 * against invariant 6 — a retried dispatch for the exact same body is still
 * deduped by the adapter, but a dispatch that regenerates slightly different
 * copy for the same decision would not be. Worth closing by threading
 * `dedupeKey` through the interface in a follow-up; noted rather than
 * silently worked around.
 */
export class RegistryNudgeDispatchSink implements NudgeDispatchSink {
  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly registry: IntegrationRegistry,
    private readonly options: { role?: string } = {},
  ) {}

  async send(input: { channel: string; recipientParticipantId: string; body: string }): Promise<void> {
    const dm = this.registry.get<DmAdapter>("dm");
    if (!dm) return; // No dm slot bound for this tenant: recorded by the sweep as dispatched=false.

    const { role } = this.options;
    const memberRef = await withTenant(
      this.db,
      this.orgId,
      async (tx) => {
        const [participant] = await tx
          .select({ userId: participants.userId })
          .from(participants)
          .where(and(eq(participants.orgId, this.orgId), eq(participants.id, input.recipientParticipantId)))
          .limit(1);
        if (!participant) return null;
        const [link] = await tx
          .select({ externalId: identityLinks.externalId })
          .from(identityLinks)
          .where(
            and(
              eq(identityLinks.orgId, this.orgId),
              eq(identityLinks.userId, participant.userId),
              eq(identityLinks.provider, "slack"),
              isNotNull(identityLinks.verifiedAt),
            ),
          )
          .limit(1);
        return link?.externalId ?? null;
      },
      role === undefined ? {} : { role },
    );
    if (!memberRef) return; // No verified chat link: dropped, not guessed.

    const idempotencyKey = createHash("sha256")
      .update(`${input.recipientParticipantId}:${input.channel}:${input.body}`)
      .digest("hex")
      .slice(0, 32);

    await dm.send({ memberRef, body: input.body, idempotencyKey });
  }
}

export function createNudgeSweepRunner(deps: SweepDeps): () => Promise<NudgeSweepEntry[]> {
  const reader = new PostgresNudgeReader(deps.db, deps.orgId, deps.role === undefined ? {} : { role: deps.role });
  const record = new PostgresNudgeRecordSink(deps.db, deps.role === undefined ? {} : { role: deps.role });
  const dispatch = new RegistryNudgeDispatchSink(deps.db, deps.orgId, deps.registry, deps.role === undefined ? {} : { role: deps.role });

  return async () => {
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const groups = await listCohortDeficitInputs(deps.db, deps.orgId, {
      ...(deps.role === undefined ? {} : { role: deps.role }),
      ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
    });

    const entries: NudgeSweepEntry[] = [];
    for (const group of groups) {
      const deficits = sweep({
        now,
        pairs: group.pairs,
        actionItems: group.actionItems,
        goals: group.goals,
        surveys: [],
        // Every dedupe key already recorded for this cohort's pairings is
        // "already emitted" — the sweep's own idempotence trick, so a sweep
        // that runs every N minutes does not re-derive (and re-nudge about)
        // the same week's absence on every tick.
        alreadyEmitted: await alreadyEmittedDedupeKeys(deps.db, deps.orgId, group.pairs.map((p) => p.pairingId), deps.role),
        thresholds: {},
      });
      if (deficits.length === 0) continue;

      const result = await runNudgeSweep({
        deficits,
        reader,
        llm: deps.llm ?? NO_LLM,
        policy: group.policy,
        orgId: deps.orgId,
        dispatch,
        record,
        ...(deps.runs ? { runs: deps.runs } : {}),
        ...(deps.llm ? {} : { inferenceEnabled: false }),
        ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
      });
      entries.push(...result.entries);
    }
    return entries;
  };
}

async function alreadyEmittedDedupeKeys(
  db: Db,
  orgId: string,
  pairingIds: string[],
  role?: string,
): Promise<string[]> {
  if (pairingIds.length === 0) return [];
  return withTenant(
    db,
    orgId,
    async (tx) => {
      const rows = await tx
        .select({ dedupeKey: nudges.dedupeKey })
        .from(nudges)
        .where(and(eq(nudges.orgId, orgId), inArray(nudges.pairingId, pairingIds)));
      return rows.map((r) => r.dedupeKey);
    },
    role === undefined ? {} : { role },
  );
}
