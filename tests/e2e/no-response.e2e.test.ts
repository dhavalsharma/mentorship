import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { escalations, named, ofKind, threadMessages } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { noResponse } from "./journeys/no-response.js";

describe("journey: no-response", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(noResponse);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("renudges exactly once, then pauses with no_response (invariant 11)", () => {
    const nudges = threadMessages(s.calls()).filter((b) => b.startsWith("Nudging gently"));
    expect(nudges).toHaveLength(1);
    expect(escalations(log)).toEqual(["no_response"]);
  });

  it("books nothing and proposes nothing more (invariant 9)", () => {
    expect(ofKind(s.calls(), "calendar.created")).toEqual([]);
    expect(named(log, "session.scheduled")).toEqual([]);
    expect(ofKind(s.calls(), "thread.proposal")).toHaveLength(1);
    expect(named(log, "agreement.opened")).toHaveLength(1);
  });
});

describeProperties(noResponse);
