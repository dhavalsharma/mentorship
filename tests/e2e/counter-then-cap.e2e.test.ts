import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import {
  agreementsOpened,
  escalations,
  named,
  ofKind,
  threadMessages,
} from "./harness/observe.js";
import { describeProperties, KNOWN_BUGS } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { counterThenCap } from "./journeys/counter-then-cap.js";

describe("journey: counter-then-cap", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(counterThenCap);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("opened the real modal, synchronously, for each Suggest another click", () => {
    const opened = ofKind(s.calls(), "slack.views.open");
    expect(opened).toHaveLength(2);
    expect(opened.every((c) => c.detail["callbackId"] === "counter_proposal")).toBe(true);
  });

  it("carried the counter as a structured UTC instant into round 2, leading the options (invariants 9, 21)", () => {
    const counters = named(log, "agreement.responded")
      .map((e) => e.payload["counter"] as { startsAt: string } | null)
      .filter((c): c is { startsAt: string } => c !== null);
    expect(counters.map((c) => c.startsAt)).toEqual([
      "2026-09-17T04:30:00.000Z",
      "2026-09-18T09:30:00.000Z",
    ]);
    const [, round2] = agreementsOpened(log);
    expect(round2!.round).toBe(2);
    expect(round2!.options[0]!.startsAt).toBe("2026-09-17T04:30:00.000Z");
  });

  it("stops at two rounds and hands it to a human (invariant 10)", () => {
    expect(agreementsOpened(log)).toHaveLength(2);
    expect(escalations(log)).toEqual(["negotiation_exhausted"]);
    expect(threadMessages(s.calls())).toContain(
      "You two seem to want different times — I'll let your program admin help sort this one out.",
    );
    expect(ofKind(s.calls(), "calendar.created")).toEqual([]);
  });
});

describeProperties(counterThenCap, {
  known: { P1: KNOWN_BUGS.redeliveredActivationRestartsPausedSaga },
});
