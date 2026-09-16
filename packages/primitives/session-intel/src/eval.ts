import type { ActionItem } from "./schema.js";

/**
 * A tiny golden-fixture eval harness for session intelligence.
 *
 * Why this exists: the roadmap calls out "golden fixtures; field-level
 * precision/recall in CI" as unfinished, and this primitive is the only one
 * that *generates* the labelled data the other three primitives will need
 * (matching, nudging, progress & risk). If its extraction quality silently
 * regresses — a cue phrase gets narrowed, a regex gets "fixed" in a way that
 * stops matching real transcripts — nothing today would notice. A handful of
 * hand-labelled cases scored on every run is cheap insurance against that.
 *
 * Deliberately narrow for now: only `actionItems` is scored (see
 * `scoreActionItems`). Blockers, goal progress and sentiment band are worth
 * scoring the same way later — the shape here (an `expected*` type per field,
 * a `score*` function returning `FieldScore`) is meant to be copied, not
 * extended in place, when a model-backed path exists and needs the same
 * harness.
 */

/**
 * One hand-labelled expectation for an action item. Matching is deliberately
 * loose on text — a full-string match would make every golden case brittle
 * against a harmless rewording — and strict on owner, because owner is the
 * field a wrong guess actually hurts (invariant: an action item attributed to
 * the wrong person is worse than one left unassigned).
 */
export interface ExpectedActionItem {
  /** A `participantId` from the fixture's pair, or `"unassigned"`. */
  owner: string;
  /** A substring `actual.text` must contain, case-insensitively. */
  textContains: string;
}

export interface FieldScore {
  precision: number;
  recall: number;
}

/**
 * Matching rule for "did an actual action item satisfy an expected one":
 * same owner (case-insensitive exact match) AND the actual item's text
 * includes the expected substring (case-insensitive). Substring rather than
 * equality because the fallback keeps the exact sentence as said — expecting
 * a human labeller to retype it verbatim would make every golden case a
 * transcription exercise instead of a judgement about what should have been
 * found.
 *
 * Matching is one-to-one: each expected item can consume at most one actual
 * item and vice versa (first free match, in order), so a single true
 * positive cannot be double-counted against two expectations.
 */
export function scoreActionItems(
  expected: ExpectedActionItem[],
  actual: ActionItem[],
): FieldScore {
  // Nothing expected and nothing found is a correct, boring answer — the
  // "no extractable commitments" golden case depends on this not being a
  // divide-by-zero. Scored as perfect on both axes rather than "undefined",
  // so an aggregate mean over cases stays a plain number.
  if (expected.length === 0 && actual.length === 0) {
    return { precision: 1, recall: 1 };
  }

  const consumed = new Set<number>();
  let matched = 0;
  for (const exp of expected) {
    const idx = actual.findIndex(
      (item, i) => !consumed.has(i) && matchesExpectedActionItem(exp, item),
    );
    if (idx !== -1) {
      consumed.add(idx);
      matched++;
    }
  }

  // Precision: of what was extracted, how much was wanted. Vacuously 1 when
  // nothing was extracted — an empty answer raises no false positives, even
  // though (handled above) it may still cost recall.
  const precision = actual.length === 0 ? 1 : matched / actual.length;
  // Recall: of what was wanted, how much was extracted. Vacuously 1 when
  // nothing was wanted (the empty-expected, non-empty-actual case is not
  // reachable here since it falls through to matched === 0 below, correctly
  // scoring recall 1 / precision 0).
  const recall = expected.length === 0 ? 1 : matched / expected.length;

  return { precision, recall };
}

function matchesExpectedActionItem(
  expected: ExpectedActionItem,
  actual: ActionItem,
): boolean {
  return (
    actual.owner.toLowerCase() === expected.owner.toLowerCase() &&
    actual.text.toLowerCase().includes(expected.textContains.toLowerCase())
  );
}

/**
 * Aggregates per-case scores into a single `FieldScore` by micro-averaging:
 * summing matches, expected counts and actual counts across every case
 * before dividing, rather than averaging each case's ratio. Micro-averaging
 * is the honest choice here because cases have very different numbers of
 * expected items (0 to 3) — macro-averaging would let the empty "no
 * commitments" case count for as much as a three-commitment case and distort
 * the read on overall quality.
 */
export function aggregateActionItemScores(
  pairs: Array<{ expected: ExpectedActionItem[]; actual: ActionItem[] }>,
): FieldScore {
  let matchedTotal = 0;
  let expectedTotal = 0;
  let actualTotal = 0;

  for (const { expected, actual } of pairs) {
    const consumed = new Set<number>();
    for (const exp of expected) {
      const idx = actual.findIndex(
        (item, i) => !consumed.has(i) && matchesExpectedActionItem(exp, item),
      );
      if (idx !== -1) {
        consumed.add(idx);
        matchedTotal++;
      }
    }
    expectedTotal += expected.length;
    actualTotal += actual.length;
  }

  if (expectedTotal === 0 && actualTotal === 0) {
    return { precision: 1, recall: 1 };
  }

  return {
    precision: actualTotal === 0 ? 1 : matchedTotal / actualTotal,
    recall: expectedTotal === 0 ? 1 : matchedTotal / expectedTotal,
  };
}

/**
 * One hand-labelled session. `source` matches `fallback.ts`'s `readLines`
 * expectations: `"Speaker: said thing"` lines, one exchange per line.
 *
 * Only action items are scored today (see the module doc). The field is
 * still named `expectedActionItems`, not `expected`, so adding
 * `expectedBlockers` etc. later is additive rather than a rename.
 */
export interface GoldenCase {
  name: string;
  source: string;
  expectedActionItems: ExpectedActionItem[];
}
