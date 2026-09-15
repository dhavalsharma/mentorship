import type { EvidenceSpan } from "@mentorship/core";
import {
  UNASSIGNED,
  type SessionIntelOutput,
} from "./schema.js";

/**
 * Evidence verification. An evidence span is only worth having if something
 * checks it — otherwise it is decoration that makes a fabricated claim look
 * better sourced than an honest one.
 *
 * Three outcomes, and the middle one is the interesting one:
 *
 *   - **exact** — `source.slice(start, end) === quote`. Believe it.
 *   - **relocated** — the quote occurs in the source, but not at the offsets
 *     claimed. Character offsets are the single most brittle thing a language
 *     model produces and the quote is the actual claim, so we repair the
 *     offsets rather than throw away a true statement over arithmetic.
 *     Ambiguity is not repaired: a quote appearing more than once has no
 *     single right answer, so a near-miss offset picks the nearest occurrence
 *     and an unanchored one is unfounded.
 *   - **unfounded** — the quote is not in the source at all. The model made it
 *     up, or is quoting its own paraphrase. Dropped, always.
 */

export type SpanCheck =
  | { status: "exact"; span: EvidenceSpan }
  | { status: "relocated"; span: EvidenceSpan; claimed: EvidenceSpan }
  | { status: "unfounded"; claimed: EvidenceSpan; reason: string };

export function checkSpan(source: string, claimed: EvidenceSpan): SpanCheck {
  const quote = claimed.quote;
  if (quote.length === 0) {
    return { status: "unfounded", claimed, reason: "empty quote" };
  }

  if (
    claimed.end > claimed.start &&
    source.slice(claimed.start, claimed.end) === quote
  ) {
    return { status: "exact", span: claimed };
  }

  const occurrences = indexesOf(source, quote);
  if (occurrences.length === 0) {
    return {
      status: "unfounded",
      claimed,
      reason: "quote does not appear in the source",
    };
  }

  // Nearest occurrence to the claimed start: when a model is off by a few
  // characters it is off near the right place, and preferring the nearest
  // match keeps a repeated phrase ("I'll follow up") attached to the exchange
  // the model was actually reading.
  let best = occurrences[0]!;
  for (const at of occurrences) {
    if (Math.abs(at - claimed.start) < Math.abs(best - claimed.start)) best = at;
  }

  return {
    status: "relocated",
    claimed,
    span: { start: best, end: best + quote.length, quote },
  };
}

/** Why a claim was thrown away, kept so the run record can say so. */
export interface DroppedClaim {
  field: "actionItems" | "goalProgress" | "blockers";
  reason: string;
  quote: string;
}

export interface VerifiedExtraction {
  output: SessionIntelOutput;
  dropped: DroppedClaim[];
  /** Spans whose offsets were wrong but whose quote was real. */
  relocated: number;
}

export class EvidenceMismatchError extends Error {
  constructor(readonly dropped: DroppedClaim[]) {
    super(
      `every evidenced claim failed verification (${dropped.length}): ` +
        dropped.map((d) => `${d.field}: ${d.reason}`).join("; "),
    );
    this.name = "EvidenceMismatchError";
  }
}

export interface VerifyOptions {
  /** Participant ids the model is allowed to name as an owner. */
  knownOwners?: string[];
  /** Goal refs the model was given. Anything else is invented. */
  knownGoals?: string[];
}

/**
 * Drops unverifiable claims and repairs recoverable ones.
 *
 * Throws `EvidenceMismatchError` only when *every* evidenced claim was
 * unfounded and there was at least one: a model confabulating wholesale is not
 * partially usable, and the runner's fallback is a better answer than a
 * confident empty one. A partial failure is a dropped claim, not an outage —
 * the alternative, rejecting the whole extraction over one bad quote, throws
 * away four good action items to punish a fifth.
 */
export function verifyExtraction(
  source: string,
  output: SessionIntelOutput,
  options: VerifyOptions = {},
): VerifiedExtraction {
  const dropped: DroppedClaim[] = [];
  let relocated = 0;
  let evidenced = 0;

  const owners = new Set(options.knownOwners ?? []);
  const goals = new Set(options.knownGoals ?? []);

  const resolve = (
    field: DroppedClaim["field"],
    span: EvidenceSpan,
  ): EvidenceSpan | null => {
    evidenced++;
    const check = checkSpan(source, span);
    if (check.status === "unfounded") {
      dropped.push({ field, reason: check.reason, quote: span.quote });
      return null;
    }
    if (check.status === "relocated") relocated++;
    return check.span;
  };

  const actionItems = output.actionItems.flatMap((item) => {
    const span = resolve("actionItems", item.evidence);
    if (!span) return [];
    // An owner the pair does not contain is a hallucinated person. Demoted
    // rather than dropped: the commitment was probably real, the attribution
    // was not, and an unassigned action item is something a human can fix in
    // one tap.
    const owner =
      owners.size === 0 || owners.has(item.owner) ? item.owner : UNASSIGNED;
    return [{ ...item, owner, evidence: span }];
  });

  const goalProgress = output.goalProgress.flatMap((item) => {
    if (goals.size > 0 && !goals.has(item.goalRef)) {
      // A goal ref that was never in context cannot be written against a real
      // goal row, and guessing which one was meant is how progress lands on
      // the wrong objective.
      evidenced++;
      dropped.push({
        field: "goalProgress",
        reason: `unknown goal ref ${item.goalRef}`,
        quote: item.evidence.quote,
      });
      return [];
    }
    const span = resolve("goalProgress", item.evidence);
    return span ? [{ ...item, evidence: span }] : [];
  });

  const blockers = output.blockers.flatMap((item) => {
    const span = resolve("blockers", item.evidence);
    return span ? [{ ...item, evidence: span }] : [];
  });

  if (evidenced > 0 && dropped.length === evidenced) {
    throw new EvidenceMismatchError(dropped);
  }

  return {
    output: { ...output, actionItems, goalProgress, blockers },
    dropped,
    relocated,
  };
}

function indexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/** Builds a span for text known to sit at `start`. Used by the fallback. */
export function spanAt(source: string, start: number, length: number): EvidenceSpan {
  return { start, end: start + length, quote: source.slice(start, start + length) };
}
