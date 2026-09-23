import type { EvidenceSpan } from "@mentorship/core";
import type { SessionIntelOutput } from "./schema.js";

/**
 * Pure scoring for `pnpm eval` (docs/e2e-testing-strategy.md, tier 5). No
 * model, no database — the runner in `evals/` does the I/O and hands the
 * results here, so the arithmetic is tested in the gate even though the eval
 * itself never is.
 *
 * An eval measures a rate against labels; it does not assert an answer. So
 * nothing here throws on a bad score, and every ratio with an empty
 * denominator is `null` ("not measurable on this set") rather than a
 * flattering 1 or an alarming 0.
 */

export type Ratio = { num: number; den: number; value: number | null };

export function ratio(num: number, den: number): Ratio {
  return { num, den, value: den === 0 ? null : num / den };
}

// ---------------------------------------------------------------------------
// Evidence spans — invariant 18
// ---------------------------------------------------------------------------

export function evidenceSpans(output: SessionIntelOutput): EvidenceSpan[] {
  return [
    ...output.actionItems.map((a) => a.evidence),
    ...output.goalProgress.map((g) => g.evidence),
    ...output.blockers.map((b) => b.evidence),
  ];
}

/**
 * Anchored: the span indexes into the unedited source and says what it
 * quotes — `source.slice(start, end) === quote`. The only check that proves a
 * claim is checkable, and the one invariant 18 is actually about.
 */
export function anchoredSpanValidity(source: string, output: SessionIntelOutput): Ratio {
  const spans = evidenceSpans(output);
  const ok = spans.filter(
    (s) => s.quote.length > 0 && s.end > s.start && source.slice(s.start, s.end) === s.quote,
  ).length;
  return ratio(ok, spans.length);
}

/**
 * Structural: the span is at least self-consistent (non-empty, in order, the
 * right length for its quote). Much weaker than anchored — it is all that can
 * be said about a stored run whose source was never recorded.
 */
export function structuralSpanValidity(output: SessionIntelOutput): Ratio {
  const spans = evidenceSpans(output);
  const ok = spans.filter(
    (s) => s.quote.length > 0 && s.start >= 0 && s.end - s.start === s.quote.length,
  ).length;
  return ratio(ok, spans.length);
}

// ---------------------------------------------------------------------------
// Safeguarding — invariant 16
// ---------------------------------------------------------------------------

export interface SafeguardingLabel {
  name: string;
  expected: boolean;
  predicted: boolean;
}

export interface SafeguardingScore {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Of the real disclosures, how many were flagged. The number that matters. */
  recall: Ratio;
  /** Of the flags raised, how many were real. Null when nothing was flagged. */
  precision: Ratio;
  missed: string[];
  falseAlarms: string[];
}

export function scoreSafeguarding(labels: SafeguardingLabel[]): SafeguardingScore {
  const tp = labels.filter((l) => l.expected && l.predicted);
  const fp = labels.filter((l) => !l.expected && l.predicted);
  const fn = labels.filter((l) => l.expected && !l.predicted);
  const tn = labels.filter((l) => !l.expected && !l.predicted);
  return {
    tp: tp.length,
    fp: fp.length,
    fn: fn.length,
    tn: tn.length,
    recall: ratio(tp.length, tp.length + fn.length),
    precision: ratio(tp.length, tp.length + fp.length),
    missed: fn.map((l) => l.name),
    falseAlarms: fp.map((l) => l.name),
  };
}

// ---------------------------------------------------------------------------
// Human verdicts from ai_runs — invariant 19's labels
// ---------------------------------------------------------------------------

/** The stored shape of one `ai_runs` row, as far as the eval cares. */
export interface AiRunRow {
  promptVersion: string;
  model: string;
  verdict: string | null;
  error: string | null;
  output: unknown;
  /** Present only if a future writer records the source; today it never does. */
  input: unknown;
}

export interface VerdictGroup {
  promptVersion: string;
  model: string;
  runs: number;
  /** Rows whose output came from `fallback` (the run recorded an error). */
  degraded: number;
  confirmed: number;
  edited: number;
  unlabelled: number;
  /** Confirmed as-is, of those a human labelled. The accuracy proxy. */
  acceptedAsIs: Ratio;
  anchoredSpans: Ratio;
  structuralSpans: Ratio;
  /** Spans on rows with no recorded source — unanchorable, counted honestly. */
  unanchorableSpans: number;
  safeguardingFlagged: number;
}

function sourceOf(input: unknown): string | null {
  if (input && typeof input === "object" && typeof (input as { source?: unknown }).source === "string") {
    return (input as { source: string }).source;
  }
  return null;
}

function asOutput(output: unknown): SessionIntelOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Partial<SessionIntelOutput>;
  if (!Array.isArray(o.actionItems) || !Array.isArray(o.goalProgress) || !Array.isArray(o.blockers)) {
    return null;
  }
  return { riskFlags: [], ...o } as SessionIntelOutput;
}

/**
 * Grouped by `prompt_version` first (invariant 20 — "did v4 help?" is the
 * question this exists to answer) and model second, since one prompt run on
 * two models is two different experiments.
 */
export function summarizeAiRuns(rows: AiRunRow[]): VerdictGroup[] {
  const groups = new Map<string, AiRunRow[]>();
  for (const row of rows) {
    const key = `${row.promptVersion}\u0000${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [promptVersion, model] = key.split("\u0000") as [string, string];
      const confirmed = group.filter((r) => r.verdict === "confirm").length;
      const edited = group.filter((r) => r.verdict === "edit").length;
      let anchoredOk = 0;
      let anchoredDen = 0;
      let structuralOk = 0;
      let structuralDen = 0;
      let unanchorable = 0;
      let flagged = 0;
      for (const row of group) {
        const output = asOutput(row.output);
        if (!output) continue;
        if (output.riskFlags?.includes("safeguarding")) flagged++;
        const structural = structuralSpanValidity(output);
        structuralOk += structural.num;
        structuralDen += structural.den;
        const source = sourceOf(row.input);
        if (source === null) {
          unanchorable += structural.den;
        } else {
          const anchored = anchoredSpanValidity(source, output);
          anchoredOk += anchored.num;
          anchoredDen += anchored.den;
        }
      }
      return {
        promptVersion,
        model,
        runs: group.length,
        degraded: group.filter((r) => r.error !== null).length,
        confirmed,
        edited,
        unlabelled: group.length - confirmed - edited,
        acceptedAsIs: ratio(confirmed, confirmed + edited),
        anchoredSpans: ratio(anchoredOk, anchoredDen),
        structuralSpans: ratio(structuralOk, structuralDen),
        unanchorableSpans: unanchorable,
        safeguardingFlagged: flagged,
      };
    })
    .sort((a, b) => a.promptVersion.localeCompare(b.promptVersion) || a.model.localeCompare(b.model));
}

export function formatRatio(r: Ratio): string {
  return r.value === null ? "n/a (0/0)" : `${r.value.toFixed(2)} (${r.num}/${r.den})`;
}
