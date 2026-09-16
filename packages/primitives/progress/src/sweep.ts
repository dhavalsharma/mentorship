import { runPrimitive, type AiRunSink } from "@mentorship/ai";
import type { GateDecision, LlmProvider, ProgramPolicy } from "@mentorship/core";
import { createProgressPrimitive, type ProgressPrimitiveOptions } from "./primitive.js";
import type { ProgressReader } from "./primitive.js";
import type { RiskFinding } from "./risk.js";

/**
 * A findings log is only worth having if something keeps writing to it — the
 * gap this closes. There is no scheduler here on purpose: `pnpm serve:worker`
 * already owns one polling loop for the event-driven path, and ADR-0008 has
 * already reserved pg-boss for exactly this cron-shaped work when it lands.
 * This is the function that loop or job would call, tested on its own so the
 * scheduling question can be answered later without touching the logic.
 */
export interface RiskFindingsSink {
  record(input: { orgId: string; pairingId: string; finding: RiskFinding }): Promise<void>;
}

export interface ProgressSweepOptions extends ProgressPrimitiveOptions {
  /** Every pairing due for an assessment this pass. The caller decides which. */
  pairingIds: string[];
  reader: ProgressReader;
  llm: LlmProvider;
  policy: ProgramPolicy;
  orgId: string;
  sink: RiskFindingsSink;
  runs?: AiRunSink;
  inferenceEnabled?: boolean;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface ProgressSweepEntry {
  pairingId: string;
  gate: GateDecision;
  degraded: boolean;
  risksWritten: number;
}

export interface ProgressSweepResult {
  entries: ProgressSweepEntry[];
}

/**
 * One assessment per pairing, findings written to `sink` regardless of gate —
 * the gate says who acts on a finding, not whether it gets recorded. A run
 * that fails is still recorded (`runPrimitive` never throws) and still
 * degrades to the deterministic composite, so a vendor outage thins out the
 * narrative, never the score.
 */
export async function runProgressSweep(
  options: ProgressSweepOptions,
): Promise<ProgressSweepResult> {
  const primitive = createProgressPrimitive(options);
  const entries: ProgressSweepEntry[] = [];

  for (const pairingId of options.pairingIds) {
    const run = await runPrimitive({
      primitive,
      trigger: { pairingId },
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

    for (const finding of run.output.risks) {
      await options.sink.record({ orgId: options.orgId, pairingId, finding });
    }

    entries.push({
      pairingId,
      gate: run.gate,
      degraded: run.degraded,
      risksWritten: run.output.risks.length,
    });
  }

  return { entries };
}
