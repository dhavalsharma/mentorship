import { describe, expect, it } from "vitest";
import { fallbackExtraction, scoreActionItems, aggregateActionItemScores } from "@mentorship/primitive-session-intel";
import { contextFixture } from "./fixtures.js";
import { GOLDEN_CASES } from "./golden-fixtures.js";

/**
 * Field-level precision/recall against the golden set, for the deterministic
 * fallback path — the only path that runs identically in CI every time (the
 * model-backed path needs a live provider and is out of scope here).
 *
 * Baseline observed on 2026-09-16, six cases, `scoreActionItems` /
 * `aggregateActionItemScores` (micro-averaged) over `GOLDEN_CASES`:
 *
 *   aggregate precision: 1.00   (4/4 — the fallback never raises a false
 *                                 positive on this set: every action item it
 *                                 does find is a real one)
 *   aggregate recall:    0.80   (4/5 — it misses exactly the case built to
 *                                 show its limit: a commitment phrased
 *                                 without any of its cue phrases)
 *
 * Thresholds below are set at these measured values (precision) or just
 * under them (recall), to leave a little headroom for minor future fixture
 * edits without masking a real regression.
 */

describe("session-intel golden fixtures (fallback path)", () => {
  const results = GOLDEN_CASES.map((golden) => {
    const ctx = contextFixture({ source: golden.source });
    const out = fallbackExtraction(ctx);
    const score = scoreActionItems(golden.expectedActionItems, out.actionItems);
    return { golden, out, score };
  });

  it.each(results.map((r) => [r.golden.name, r] as const))(
    "%s",
    (_name, r) => {
      // Every case gets its score recorded (via the assertions below); this
      // is mostly a hook so a failing case's name shows up in test output
      // rather than only in the aggregate.
      expect(r.score.precision).toBeGreaterThanOrEqual(0);
      expect(r.score.recall).toBeGreaterThanOrEqual(0);
    },
  );

  it("finds nothing for the 'no extractable commitments' case", () => {
    const noCommitments = results.find(
      (r) => r.golden.name === "no extractable commitments at all",
    )!;
    expect(noCommitments.out.actionItems).toHaveLength(0);
    // Zero expected, zero actual: scored as trivially perfect, not NaN.
    expect(noCommitments.score).toEqual({ precision: 1, recall: 1 });
  });

  it("catches the clear, cue-phrase-shaped commitments", () => {
    const clear = results.find((r) => r.golden.name === "clear commitment with a due date")!;
    expect(clear.score).toEqual({ precision: 1, recall: 1 });

    const both = results.find(
      (r) => r.golden.name === "multi-speaker exchange with commitments from both sides",
    )!;
    expect(both.score).toEqual({ precision: 1, recall: 1 });
  });

  it("documents the known miss: a commitment phrased without a cue phrase", () => {
    const tricky = results.find(
      (r) => r.golden.name === "commitment phrased in a way the cue-phrase regexes miss",
    )!;
    // This is the case the golden set exists to be honest about: the
    // fallback finds nothing here, so recall on this single case is 0. If
    // this ever starts passing, it means the cue list grew a phrase for it —
    // update this test's expectation deliberately, don't just delete it.
    expect(tricky.out.actionItems).toHaveLength(0);
    expect(tricky.score).toEqual({ precision: 1, recall: 0 });
  });

  it("meets the measured aggregate precision/recall bar", () => {
    const aggregate = aggregateActionItemScores(
      results.map((r) => ({ expected: r.golden.expectedActionItems, actual: r.out.actionItems })),
    );

    // Measured: precision 1.00, recall 0.80 (see the module-level comment).
    // Precision asserted at the measured floor — any false positive here is
    // a real regression, not noise. Recall given a little headroom below the
    // measured value.
    expect(aggregate.precision).toBeGreaterThanOrEqual(1.0);
    expect(aggregate.recall).toBeGreaterThanOrEqual(0.75);
  });
});
