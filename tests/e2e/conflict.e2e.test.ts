import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { agreementsOpened, escalations, named, ofKind } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { conflict } from "./journeys/conflict.js";

describe("journey: conflict", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(conflict);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("does not book either pick when the two differ", () => {
    const [round1, round2] = agreementsOpened(log);
    expect(round2!.round).toBe(2);
    // Round 2 leads with exactly the two slots that were picked.
    expect(round2!.options.slice(0, 2).map((o) => o.startsAt)).toEqual([
      round1!.options[0]!.startsAt,
      round1!.options[1]!.startsAt,
    ]);
  });

  it("says who picked what before re-offering", () => {
    const [, second] = ofKind(s.calls(), "thread.proposal");
    const [round1] = agreementsOpened(log);
    expect(String(second!.detail["body"])).toContain(
      `Arjun Rao picked ${round1!.options[0]!.label}, Priya Menon picked ${round1!.options[1]!.label} — let's find one that works for both:`,
    );
  });

  it("books the slot they converge on, once", () => {
    const [, round2] = agreementsOpened(log);
    expect(ofKind(s.calls(), "calendar.created")).toHaveLength(1);
    expect(named(log, "session.scheduled")[0]!.payload["startsAt"]).toBe(
      round2!.options[1]!.startsAt,
    );
    expect(escalations(log)).toEqual([]);
  });
});

describeProperties(conflict);
