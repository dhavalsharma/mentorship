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

  // Was bug #4: a failing (not absent) DM slot wedged the lifecycle at the
  // reminder, and because `SagaEngine.tick()` had no per-instance failure
  // handling every pass for the org threw. Now a throwing timer step is
  // recorded on its own instance and backed off (never aborting the pass),
  // and a DM that fails again on the retry degrades — escalated, not sent,
  // never re-routed to the thread — so the session carries on.
  it("still holds the session and extracts the notes while DMs are failing", () => {
    expect(named(log, "session.held")).toHaveLength(1);
    expect(named(log, "extraction.completed")).toHaveLength(1);
    expect(s.logs().filter((l) => l.includes("pass threw"))).toEqual([]);
  });
});

describeProperties(dmOutage);
