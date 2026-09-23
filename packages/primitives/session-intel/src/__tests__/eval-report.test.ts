import { describe, expect, it } from "vitest";
import {
  anchoredSpanValidity,
  emptyOutput,
  formatRatio,
  scoreSafeguarding,
  structuralSpanValidity,
  summarizeAiRuns,
  type SessionIntelOutput,
} from "@mentorship/primitive-session-intel";

/** The arithmetic behind `pnpm eval`, deterministic, in the gate. */

const SOURCE = "Sam: I'll send the notes by Friday.";

function withSpan(start: number, end: number, quote: string): SessionIntelOutput {
  return {
    ...emptyOutput(),
    actionItems: [{ owner: "part_mentor", text: "send notes", dueHint: null, evidence: { start, end, quote } }],
  };
}

describe("span validity", () => {
  it("anchored: a span must index into the source and quote what is there", () => {
    const quote = "I'll send the notes by Friday.";
    const at = SOURCE.indexOf(quote);
    expect(anchoredSpanValidity(SOURCE, withSpan(at, at + quote.length, quote)).value).toBe(1);
    // Right length, wrong place: structurally fine, not anchored.
    expect(anchoredSpanValidity(SOURCE, withSpan(0, quote.length, quote)).value).toBe(0);
    expect(structuralSpanValidity(withSpan(0, quote.length, quote)).value).toBe(1);
  });

  it("has no score, rather than a perfect one, when there are no spans", () => {
    expect(anchoredSpanValidity(SOURCE, emptyOutput())).toEqual({ num: 0, den: 0, value: null });
    expect(formatRatio(anchoredSpanValidity(SOURCE, emptyOutput()))).toBe("n/a (0/0)");
  });
});

describe("scoreSafeguarding", () => {
  it("counts recall over real disclosures, and has no precision when nothing was flagged", () => {
    const score = scoreSafeguarding([
      { name: "a", expected: true, predicted: false },
      { name: "b", expected: true, predicted: true },
      { name: "c", expected: false, predicted: false },
    ]);
    expect(score.recall.value).toBe(0.5);
    expect(score.precision.value).toBe(1);
    expect(score.missed).toEqual(["a"]);

    const none = scoreSafeguarding([{ name: "a", expected: true, predicted: false }]);
    expect(none.precision.value).toBeNull();
    expect(none.recall.value).toBe(0);
  });
});

describe("summarizeAiRuns", () => {
  it("groups by prompt_version then model, and scores verdicts as labels", () => {
    const quote = "I'll send the notes by Friday.";
    const at = SOURCE.indexOf(quote);
    const output = withSpan(at, at + quote.length, quote);
    const groups = summarizeAiRuns([
      { promptVersion: "session.intel@v1", model: "m", verdict: "confirm", error: null, output, input: null },
      { promptVersion: "session.intel@v1", model: "m", verdict: "edit", error: null, output, input: null },
      { promptVersion: "session.intel@v1", model: "m", verdict: null, error: "503", output: null, input: null },
      {
        promptVersion: "session.intel@v2",
        model: "m",
        verdict: "confirm",
        error: null,
        output: { ...output, riskFlags: ["safeguarding"] },
        input: { source: SOURCE },
      },
    ]);

    expect(groups.map((g) => g.promptVersion)).toEqual(["session.intel@v1", "session.intel@v2"]);
    const [v1, v2] = groups;
    expect(v1).toMatchObject({ runs: 3, degraded: 1, confirmed: 1, edited: 1, unlabelled: 1 });
    expect(v1!.acceptedAsIs.value).toBe(0.5);
    // No source recorded: the spans can only be checked for shape.
    expect(v1!.unanchorableSpans).toBe(2);
    expect(v1!.anchoredSpans.value).toBeNull();
    expect(v2!.anchoredSpans.value).toBe(1);
    expect(v2!.safeguardingFlagged).toBe(1);
  });
});
