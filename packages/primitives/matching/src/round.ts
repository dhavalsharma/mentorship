import { createMatchingPrimitive } from "./primitive.js";
import type { PipelineOptions } from "./pipeline.js";
import type { MatchingPrimitiveOptions } from "./primitive.js";
import type { MatchAssignment, MatchingOutput, MatchingReader, MatchingTrigger } from "./types.js";
import type { GateDecision, LlmProvider, ProgramPolicy } from "@mentorship/core";
import type { AiRunSink } from "@mentorship/ai";
import { runPrimitive } from "@mentorship/ai";

/**
 * The bridge from a matching run to an actual pairing, mirroring how
 * `@mentorship/roster`'s `commitRosterImport` turns a plan into rows: propose,
 * then commit as a separate, explicit step (ADR-0003 — an imported pair and a
 * matched one produce the identical `pair.activated` event, and nothing
 * downstream can tell them apart).
 *
 * `MatchingCommitSink` is declared here rather than imported from
 * `@mentorship/roster`'s `RosterSink`, for the same reason
 * `packages/primitives/session-intel/src/adapter.ts` re-declares `SessionIntel`
 * instead of importing it from `workflows`: the dependency direction is
 * one-way, and a primitive importing another surface package inverts it. The
 * shapes below are a structural subset of `RosterSink`, so `World` — which
 * already implements `RosterSink` for the roster path — satisfies this with
 * no changes.
 */
export interface MatchingCommitSink {
  createPairing(input: {
    pairKey: string;
    mentorParticipantId: string;
    menteeParticipantId: string;
    state: "active" | "offered";
    origin: "matched";
    cadenceOverride: null;
    startsAt: string | null;
    notes: string | null;
    importFileHash: string;
  }): Promise<{ pairingId: string }>;
  announce(input: {
    pairingId: string;
    state: "active" | "offered";
    participantIds: string[];
  }): Promise<void>;
}

export interface CommitMatchingRoundOptions {
  /** `active` goes straight into the session lifecycle; `offered` waits for both to accept. */
  pairsStart: "active" | "offered";
}

export interface CommitMatchingRoundResult {
  created: { menteeId: string; mentorId: string; pairingId: string }[];
}

/**
 * Commits every assignment a matching run produced. Called once an admin has
 * approved the round — `gate` on the primitive's output says whether that
 * approval is required (`runMatchingRound` below never calls this on its own
 * unless the gate says `auto`).
 */
export async function commitMatchingRound(
  output: MatchingOutput,
  sink: MatchingCommitSink,
  options: CommitMatchingRoundOptions,
): Promise<CommitMatchingRoundResult> {
  const created: CommitMatchingRoundResult["created"] = [];
  const runRef = `matching:${output.cohortId}:${output.asOf}`;

  for (const assignment of output.assignments) {
    const { pairingId } = await sink.createPairing({
      pairKey: `${assignment.mentorId}:${assignment.menteeId}`,
      mentorParticipantId: assignment.mentorId,
      menteeParticipantId: assignment.menteeId,
      state: options.pairsStart,
      origin: "matched",
      cadenceOverride: null,
      startsAt: null,
      notes: assignment.rationale,
      importFileHash: runRef,
    });

    // The same announcement an imported pair makes. Nothing downstream can
    // tell that this one came out of the solver rather than a spreadsheet.
    await sink.announce({
      pairingId,
      state: options.pairsStart,
      participantIds: [assignment.mentorId, assignment.menteeId],
    });

    created.push({ menteeId: assignment.menteeId, mentorId: assignment.mentorId, pairingId });
  }

  return { created };
}

export interface RunMatchingRoundOptions extends MatchingPrimitiveOptions {
  trigger: MatchingTrigger;
  reader: MatchingReader;
  llm: LlmProvider;
  policy: ProgramPolicy;
  orgId: string;
  sink: MatchingCommitSink;
  pairsStart?: "active" | "offered";
  runs?: AiRunSink;
  inferenceEnabled?: boolean;
}

export interface RunMatchingRoundResult {
  output: MatchingOutput;
  gate: GateDecision;
  degraded: boolean;
  /** Non-null only when the gate let the round commit without a human. */
  committed: CommitMatchingRoundResult | null;
}

/**
 * One end-to-end round: resolve the pool, run the primitive, and — only when
 * `gate` says `auto` — commit straight through. Every other gate (`approve`,
 * `log`, `escalate`) returns the proposal uncommitted; the caller is
 * responsible for showing it to an admin and calling `commitMatchingRound`
 * itself once approved. Matching defaults to `requireAdminApproval: true`
 * (`createMatchingPrimitive`'s `gate`), so `auto`-commit here is the opt-in
 * a program earns by turning that off in policy, not the default behaviour.
 */
export async function runMatchingRound(
  options: RunMatchingRoundOptions,
): Promise<RunMatchingRoundResult> {
  const primitive = createMatchingPrimitive(pipelineOptionsOf(options));
  const run = await runPrimitive({
    primitive,
    trigger: options.trigger,
    reader: options.reader,
    llm: options.llm,
    policy: options.policy,
    orgId: options.orgId,
    ...(options.runs ? { runs: options.runs } : {}),
    ...(options.inferenceEnabled === undefined ? {} : { inferenceEnabled: options.inferenceEnabled }),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  const committed =
    run.gate === "auto"
      ? await commitMatchingRound(run.output, options.sink, {
          pairsStart: options.pairsStart ?? "active",
        })
      : null;

  return { output: run.output, gate: run.gate, degraded: run.degraded, committed };
}

function pipelineOptionsOf(options: RunMatchingRoundOptions): PipelineOptions & {
  prompts?: MatchingPrimitiveOptions["prompts"];
  promptRef?: string;
  onWarn?: MatchingPrimitiveOptions["onWarn"];
} {
  const { scorers, constraints, solver, scoreIneligible, prompts, promptRef, onWarn } = options;
  return {
    ...(scorers ? { scorers } : {}),
    ...(constraints ? { constraints } : {}),
    ...(solver ? { solver } : {}),
    ...(scoreIneligible === undefined ? {} : { scoreIneligible }),
    ...(prompts ? { prompts } : {}),
    ...(promptRef ? { promptRef } : {}),
    ...(onWarn ? { onWarn } : {}),
  };
}

/** Re-exported for callers that want to name an assignment without the whole output. */
export type { MatchAssignment };
