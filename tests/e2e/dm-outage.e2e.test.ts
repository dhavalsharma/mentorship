import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { named, threadMessages } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { dmOutage } from "./journeys/dm-outage.js";

describe("journey: dm-outage", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(dmOutage);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("never posts a private message to the joint thread instead (invariant 13)", () => {
    const thread = threadMessages(s.calls());
    expect(thread.filter((b) => b.startsWith("Heads up:"))).toEqual([]);
    expect(thread.filter((b) => b.startsWith("Was that session useful?"))).toEqual([]);
  });

  it("tried, and the failure is visible to an operator", () => {
    expect(s.logs().some((l) => l.includes("dm outage"))).toBe(true);
  });

  // KNOWN BUG — a failing (not absent) DM slot wedges the lifecycle. The
  // reminder step's per-participant `dm` effects throw, so the step never
  // saves; `armed` stays due, and every tick re-runs it and throws again —
  // the pair never reaches `held`, their notes match nothing, no extraction,
  // no feedback. Worse, `SagaEngine.tick()` has no per-instance failure
  // handling, so that throw aborts the whole tick: every *other* due timer in
  // the org is skipped too, every pass, for as long as the DM vendor is down
  // (`worker.pass()` rejects; `main.ts` logs and loops). The effect runner
  // degrades an *empty* dm slot (warn, not sent) but lets a *failing* one
  // propagate. Flip to `it` when a DM failure degrades rather than wedges.
  it.fails("still holds the session and extracts the notes while DMs are failing", () => {
    expect(named(log, "session.held")).toHaveLength(1);
    expect(named(log, "extraction.completed")).toHaveLength(1);
    expect(s.logs().filter((l) => l.includes("pass threw"))).toEqual([]);
  });
});

describeProperties(dmOutage);
