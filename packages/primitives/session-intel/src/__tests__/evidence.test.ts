import { describe, expect, it } from "vitest";
import {
  EvidenceMismatchError,
  checkSpan,
  emptyOutput,
  verifyExtraction,
  type SessionIntelOutput,
} from "@mentorship/primitive-session-intel";
import { TRANSCRIPT, spanOf } from "./fixtures.js";

/**
 * An evidence span nobody checks is worse than no span at all: it makes a
 * fabricated claim look better sourced than an honest one. This file is the
 * check.
 */

const QUOTE = "I'll review your draft packet by Friday and send comments.";

describe("checkSpan", () => {
  it("accepts a span whose offsets hold", () => {
    const check = checkSpan(TRANSCRIPT, spanOf(TRANSCRIPT, QUOTE));
    expect(check.status).toBe("exact");
  });

  it("relocates a real quote whose offsets are wrong", () => {
    const truth = spanOf(TRANSCRIPT, QUOTE);
    const check = checkSpan(TRANSCRIPT, { ...truth, start: 3, end: 3 + QUOTE.length });
    expect(check.status).toBe("relocated");
    if (check.status !== "relocated") return;
    expect(check.span.start).toBe(truth.start);
    expect(TRANSCRIPT.slice(check.span.start, check.span.end)).toBe(QUOTE);
  });

  it("picks the occurrence nearest the claimed offset when a quote repeats", () => {
    const source = "a: same line\nb: filler\nc: same line";
    const second = source.lastIndexOf("same line");
    const check = checkSpan(source, {
      start: second + 2,
      end: second + 2 + "same line".length,
      quote: "same line",
    });
    expect(check.status).toBe("relocated");
    if (check.status !== "relocated") return;
    expect(check.span.start).toBe(second);
  });

  it("rejects a quote that is not in the source at all", () => {
    const check = checkSpan(TRANSCRIPT, {
      start: 0,
      end: 20,
      quote: "I promise to resign next week.",
    });
    expect(check.status).toBe("unfounded");
  });

  it("rejects an empty quote rather than matching everything", () => {
    expect(checkSpan(TRANSCRIPT, { start: 0, end: 0, quote: "" }).status).toBe(
      "unfounded",
    );
  });
});

function outputWith(over: Partial<SessionIntelOutput>): SessionIntelOutput {
  return { ...emptyOutput(), ...over };
}

describe("verifyExtraction", () => {
  const good = {
    owner: "part_mentor",
    text: "Review the draft packet",
    dueHint: "by Friday",
    evidence: spanOf(TRANSCRIPT, QUOTE),
  };

  it("keeps a claim that checks out", () => {
    const result = verifyExtraction(TRANSCRIPT, outputWith({ actionItems: [good] }), {
      knownOwners: ["part_mentor", "part_mentee"],
    });
    expect(result.output.actionItems).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops a fabricated claim and keeps the real ones beside it", () => {
    const result = verifyExtraction(
      TRANSCRIPT,
      outputWith({
        actionItems: [
          good,
          {
            owner: "part_mentee",
            text: "Resign",
            dueHint: null,
            // Never said by anyone.
            evidence: { start: 0, end: 10, quote: "I am quitting the programme" },
          },
        ],
      }),
      { knownOwners: ["part_mentor", "part_mentee"] },
    );

    expect(result.output.actionItems).toHaveLength(1);
    expect(result.output.actionItems[0]!.text).toBe("Review the draft packet");
    expect(result.dropped[0]!.reason).toMatch(/does not appear/);
  });

  it("repairs offsets rather than discarding a true statement over arithmetic", () => {
    const truth = spanOf(TRANSCRIPT, QUOTE);
    const result = verifyExtraction(
      TRANSCRIPT,
      outputWith({
        actionItems: [{ ...good, evidence: { ...truth, start: 0, end: QUOTE.length } }],
      }),
    );
    expect(result.relocated).toBe(1);
    expect(result.output.actionItems[0]!.evidence.start).toBe(truth.start);
  });

  it("demotes an owner the pair does not contain instead of trusting it", () => {
    const result = verifyExtraction(
      TRANSCRIPT,
      outputWith({ actionItems: [{ ...good, owner: "part_someone_else" }] }),
      { knownOwners: ["part_mentor", "part_mentee", "unassigned"] },
    );
    // Kept — the commitment was real — but attributed to nobody, which a human
    // fixes in one tap. An action item on the wrong person is invisible until
    // the next session.
    expect(result.output.actionItems[0]!.owner).toBe("unassigned");
  });

  it("drops goal progress against a goal that was never in context", () => {
    const result = verifyExtraction(
      TRANSCRIPT,
      outputWith({
        goalProgress: [
          {
            goalRef: "goal_invented",
            direction: "advanced",
            note: "moved",
            evidence: spanOf(TRANSCRIPT, QUOTE),
          },
          {
            goalRef: "goal_1",
            direction: "blocked",
            note: "waiting on data",
            evidence: spanOf(TRANSCRIPT, "I'm blocked on getting the metrics"),
          },
        ],
      }),
      { knownGoals: ["goal_1"] },
    );

    expect(result.output.goalProgress).toHaveLength(1);
    expect(result.output.goalProgress[0]!.goalRef).toBe("goal_1");
    expect(result.dropped[0]!.reason).toMatch(/unknown goal ref/);
  });

  it("throws when every evidenced claim is fabricated, so the runner can fall back", () => {
    expect(() =>
      verifyExtraction(
        TRANSCRIPT,
        outputWith({
          blockers: [
            { text: "a", evidence: { start: 0, end: 1, quote: "never said this" } },
          ],
        }),
      ),
    ).toThrow(EvidenceMismatchError);
  });

  it("does not throw for an extraction that makes no evidenced claims", () => {
    // A quiet session is a legitimate answer; only a summary needs no span.
    const result = verifyExtraction(
      TRANSCRIPT,
      outputWith({ summary: ["Short check-in, nothing committed."] }),
    );
    expect(result.output.summary).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });
});
