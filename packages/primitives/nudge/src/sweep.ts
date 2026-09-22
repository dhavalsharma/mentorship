import { runPrimitive, type AiRunSink } from "@mentorship/ai";
import type { GateDecision, LlmProvider, ProgramPolicy } from "@mentorship/core";
import { createNudgePlanner, type NudgePlannerOptions } from "./planner.js";
import { toneRank } from "./templates.js";
import type { NudgeDecision, NudgeReader } from "./context.js";
import type { Deficit } from "./deficits.js";

/**
 * The loop a scheduler would call, mirroring `runProgressSweep` and
 * `runMatchingRound`: turn every deficit the sweep in `deficits.ts` produced
 * into a decision, and act on it.
 *
 * `NudgeDispatchSink` is declared here rather than imported from
 * `@mentorship/integrations`, for the same one-way-dependency reason
 * `MatchingCommitSink` is declared in `matching/src/round.ts` instead of
 * importing `RosterSink`: a primitive importing a surface package inverts the
 * dependency direction CLAUDE.md fixes at "integrations → core". The shape
 * below is a structural subset of what a DM/conversation adapter can already
 * do, so a real adapter satisfies it with no changes.
 */
export interface NudgeDispatchSink {
  send(input: {
    channel: string;
    recipientParticipantId: string;
    body: string;
    /**
     * The sweep's own dedupe key for this decision (invariant 6: effects are
     * idempotent by key). A dispatch sink should derive its transport-level
     * idempotency key from this, not from the message content — content can
     * legitimately vary between two dispatch attempts for the exact same
     * underlying decision (a retried sweep after a transient failure, a
     * bandit-drafted body that differs slightly run to run), and hashing the
     * content instead would let two attempts at the same decision both send.
     */
    dedupeKey: string;
  }): Promise<void>;
}

/**
 * `NudgeRecordSink` is a structural subset of the existing `nudges` table
 * (see `packages/db/src/schema.ts`) — one row per decision, whatever the
 * outcome, so dedupe and history have something to read on the next sweep
 * even for a decision nobody ever tries to deliver.
 */
export interface NudgeRecordSink {
  record(input: {
    orgId: string;
    pairingId: string;
    /** Null only for an escalation — addressed to a human, not a participant. */
    recipientParticipantId: string | null;
    channel: string;
    state: "planned" | "sent" | "dropped";
    escalationLevel: number;
    body: string;
    dedupeKey: string;
    droppedReason: string | null;
    sentAt: string | null;
  }): Promise<void>;
}

export interface NudgeSweepOptions extends NudgePlannerOptions {
  /** Every absence this pass should consider. The caller — the temporal sweep
   * in `deficits.ts`, run against fresh reads — decides which. */
  deficits: Deficit[];
  reader: NudgeReader;
  llm: LlmProvider;
  policy: ProgramPolicy;
  orgId: string;
  dispatch: NudgeDispatchSink;
  record: NudgeRecordSink;
  runs?: AiRunSink;
  inferenceEnabled?: boolean;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
  /** Stamped on a delivered nudge's `sentAt`. Defaults to the wall clock. */
  now?: () => string;
}

export interface NudgeSweepEntry {
  dedupeKey: string;
  pairingId: string;
  gate: GateDecision;
  degraded: boolean;
  outcome: NudgeDecision["outcome"];
  dispatched: boolean;
  dispatchError: string | null;
}

export interface NudgeSweepResult {
  entries: NudgeSweepEntry[];
}

/**
 * One planner run per deficit, dispatched only when the gate chain actually
 * let it through, and recorded either way.
 *
 * Never throws for one deficit's failure — a reader hiccup or a dispatch
 * outage on one pair must not cost every other recipient in the sweep, the
 * same isolation `matching`'s `infer()` gives one mentee's adjudication
 * failure (`packages/primitives/matching/src/primitive.ts`).
 */
export async function runNudgeSweep(options: NudgeSweepOptions): Promise<NudgeSweepResult> {
  const primitive = createNudgePlanner(plannerOptionsOf(options));
  const now = options.now ?? (() => new Date().toISOString());
  const entries: NudgeSweepEntry[] = [];

  for (const deficit of options.deficits) {
    try {
      const run = await runPrimitive({
        primitive,
        trigger: deficit,
        reader: options.reader,
        llm: options.llm,
        policy: options.policy,
        orgId: options.orgId,
        ...(options.runs ? { runs: options.runs } : {}),
        ...(options.inferenceEnabled === undefined
          ? {}
          : { inferenceEnabled: options.inferenceEnabled }),
        ...(options.onWarn ? { onWarn: options.onWarn } : {}),
      });

      const decision = run.output;
      let dispatched = false;
      let dispatchError: string | null = null;

      // `gate === "auto"` is exactly "every gate passed and the decision says
      // send" (see `createNudgePlanner`'s `gate`): a drop or an escalation is
      // recorded below but never handed to the dispatch sink.
      if (
        run.gate === "auto" &&
        decision.outcome === "send" &&
        decision.plan.recipientParticipantId !== null
      ) {
        try {
          await options.dispatch.send({
            channel: decision.plan.channel,
            recipientParticipantId: decision.plan.recipientParticipantId,
            body: decision.plan.body,
            dedupeKey: decision.dedupeKey,
          });
          dispatched = true;
        } catch (caught) {
          dispatchError = caught instanceof Error ? caught.message : String(caught);
          options.onWarn?.("nudge dispatch failed", {
            dedupeKey: decision.dedupeKey,
            pairingId: decision.pairingId,
            reason: dispatchError,
          });
        }
      }

      await options.record.record({
        orgId: options.orgId,
        pairingId: decision.pairingId,
        recipientParticipantId: decision.plan.recipientParticipantId,
        channel: decision.plan.channel,
        state: stateFor(decision, dispatched),
        escalationLevel: toneRank(decision.plan.tone),
        body: decision.plan.body,
        dedupeKey: decision.dedupeKey,
        droppedReason: droppedReasonFor(decision, dispatchError),
        sentAt: dispatched ? now() : null,
      });

      entries.push({
        dedupeKey: decision.dedupeKey,
        pairingId: decision.pairingId,
        gate: run.gate,
        degraded: run.degraded,
        outcome: decision.outcome,
        dispatched,
        dispatchError,
      });
    } catch (caught) {
      options.onWarn?.("nudge sweep failed for one deficit", {
        dedupeKey: deficit.dedupeKey,
        pairingId: deficit.pairingId,
        reason: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  return { entries };
}

/**
 * `planned`, not `sent`, when the decision said send but delivery itself
 * failed: the row must not claim a delivery that did not happen (the same
 * discipline invariant 19 asks of a timed-out extraction — never silently
 * promote a guess to a fact). The dedupe key still lands, which keeps the
 * decision from being re-planned on the very next sweep; `droppedReason`
 * carries the failure for whoever looks.
 */
function stateFor(decision: NudgeDecision, dispatched: boolean): "planned" | "sent" | "dropped" {
  if (decision.outcome === "drop") return "dropped";
  if (dispatched) return "sent";
  return "planned";
}

function droppedReasonFor(decision: NudgeDecision, dispatchError: string | null): string | null {
  if (decision.outcome === "drop") return decision.dropReason;
  if (decision.outcome === "escalate") return decision.plan.rationale;
  if (dispatchError) return `dispatch failed: ${dispatchError}`;
  return null;
}

function plannerOptionsOf(options: NudgeSweepOptions): NudgePlannerOptions {
  const { bandit, rng, limits, clock } = options;
  return {
    ...(bandit ? { bandit } : {}),
    ...(rng ? { rng } : {}),
    ...(limits ? { limits } : {}),
    ...(clock ? { clock } : {}),
  };
}
