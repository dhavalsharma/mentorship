import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { escalations, named, ofKind, threadMessages } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { oneSided } from "./journeys/one-sided.js";

describe("journey: one-sided", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(oneSided);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("announces the one pick and who is still owed an answer", () => {
    expect(
      threadMessages(s.calls()).filter((b) => b.startsWith("Arjun Rao picked")),
    ).toEqual([expect.stringMatching(/Waiting on Priya Menon\.$/)]);
  });

  it("pauses with one_sided_response and books nothing (invariant 9)", () => {
    expect(escalations(log)).toEqual(["one_sided_response"]);
    expect(ofKind(s.calls(), "calendar.created")).toEqual([]);
    expect(named(log, "session.scheduled")).toEqual([]);
  });

  // KNOWN BUG — session-lifecycle.ts, `proposing`: the `partial_response`
  // branch escalates on the *first* timeout, ahead of the renudge check, so a
  // one-sided silence gets zero renudges where a two-sided one gets one.
  // Invariant 11 ("renudge once, then escalate") and the strategy doc's
  // catalogue ("exactly one renudge -> paused: one_sided_response") both say
  // the silent party is owed one. Flip to `it` when fixed.
  it.fails("renudges the silent party exactly once before pausing (invariant 11)", () => {
    const nudges = threadMessages(s.calls()).filter((b) => b.startsWith("Nudging gently"));
    expect(nudges).toHaveLength(1);
  });
});

describeProperties(oneSided);
