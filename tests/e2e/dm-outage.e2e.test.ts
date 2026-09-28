import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { escalations, named, ofKind, threadMessages } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { dmOutage, dmOutageNoThread } from "./journeys/dm-outage.js";

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

// PR #13 review: with no thread, the shared messages ride `broadcast`, which
// used to call `dm.send` bare — every attempt threw, and the tick parked the
// pair after five. Now it is the same retry-once-then-degrade policy as a
// private DM, per recipient.
describe("journey: dm-outage-no-thread", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(dmOutageNoThread);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("has no thread to post to, and nothing reaches one", () => {
    expect(ofKind(s.calls(), "thread.proposal")).toEqual([]);
    expect(threadMessages(s.calls())).toEqual([]);
  });

  it("escalates each undelivered shared message per recipient, rather than parking the pair", () => {
    const undeliverable = named(log, "saga.escalated").filter(
      (e) => e.payload["reason"] === "dm_undeliverable",
    );
    const shared = undeliverable.filter((e) => String(e.payload["detail"]).startsWith("shared message"));
    // Proposal, first-pick status, booked confirmation, reminder — to each
    // of the two.
    expect(shared).toHaveLength(8);
    // Plus the two private heads-ups on the reminder step.
    expect(undeliverable).toHaveLength(10);
    expect(escalations(log)).not.toContain("saga_step_failed");
  });

  it("stays live through the outage: the unseen proposal is still bookable, and the reminder step completes", () => {
    expect(named(log, "agreement.opened")).toHaveLength(1);
    expect(named(log, "session.scheduled")).toHaveLength(1);
    // The booking step emits `session.scheduled` and then fails on the
    // booked confirmation; the event must still reach the saga once that
    // step is finished, not be dropped as unwanted (see `awaits`).
    expect(escalations(log)).not.toContain("calendar_never_confirmed");
    expect(named(log, "session.reminded")).toHaveLength(1);
    expect(s.logs().filter((l) => l.includes("pass threw"))).toEqual([]);
  });
});

describeProperties(dmOutageNoThread);
