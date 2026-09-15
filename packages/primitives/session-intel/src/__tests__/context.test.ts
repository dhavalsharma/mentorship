import { describe, expect, it } from "vitest";
import { resolveSessionIntelContext } from "@mentorship/primitive-session-intel";
import { TRANSCRIPT, pairFixture } from "./fixtures.js";

/**
 * `resolve` is the cheap, deterministic, testable part — and the first thing
 * to fix when extraction quality is bad.
 */

const trigger = {
  sessionId: "sess_1",
  pairingId: "pair_1",
  sourceRef: "transcript:fake:1",
  sourceKind: "transcript" as const,
  text: TRANSCRIPT,
};

describe("resolveSessionIntelContext", () => {
  it("assembles the pair without touching a model or a database", async () => {
    const ctx = await resolveSessionIntelContext(trigger, {
      async pairContext() {
        return pairFixture();
      },
    });

    expect(ctx.orgId).toBe("org_1");
    expect(ctx.participants.map((p) => p.participantId)).toEqual([
      "part_mentor",
      "part_mentee",
    ]);
    // No goals resolver means no goals, not invented ones.
    expect(ctx.goals).toEqual([]);
  });

  it("carries the source through unedited, because spans index into it", async () => {
    const messy = "  Priya Nair:   I'll do it.  \n\n";
    const ctx = await resolveSessionIntelContext(
      { ...trigger, text: messy },
      { async pairContext() { return pairFixture(); } },
    );
    expect(ctx.source).toBe(messy);
  });

  it("requires unanimous AI-processing consent", async () => {
    const pair = pairFixture();
    pair.participants[1]!.consent.aiProcessing = false;

    const ctx = await resolveSessionIntelContext(trigger, {
      async pairContext() {
        return pair;
      },
    });

    // One participant's refusal is not outvoted by the other's agreement: the
    // text is about both of them.
    expect(ctx.inferenceAllowed).toBe(false);
  });

  it("does not treat a pair with no participants as unanimous consent", async () => {
    const ctx = await resolveSessionIntelContext(trigger, {
      async pairContext() {
        return { ...pairFixture(), participants: [] };
      },
    });
    // `[].every(...)` is true, which is exactly the kind of vacuous truth that
    // turns into "we processed it because nobody objected".
    expect(ctx.inferenceAllowed).toBe(false);
  });
});
