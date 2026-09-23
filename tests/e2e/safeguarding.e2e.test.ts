import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney, type Journey } from "./harness/journey.js";
import { agreementsOpened, named, ofKind, threadMessages } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import {
  SAFEGUARDING_CONTACT,
  safeguarding,
  safeguardingUnconfigured,
} from "./journeys/safeguarding.js";

/** What must hold whether or not a contact is configured (invariant 16). */
function neverReachesThePair(journey: Journey, get: () => { s: Stage; log: StageEvent[] }): void {
  it("flags it, and never renders the doc or asks the pair to confirm", () => {
    const { s, log } = get();
    expect(named(log, "extraction.completed")[0]!.payload["safeguarding"]).toBe(true);
    expect(named(log, "safeguarding.flagged")).toHaveLength(1);
    expect(ofKind(s.calls(), "document.rendered")).toEqual([]);
    expect(ofKind(s.calls(), "thread.confirmation")).toEqual([]);
    expect(named(log, "extraction.confirmed")).toEqual([]);
  });

  it("puts nothing about it in front of either participant", () => {
    const { s } = get();
    const toPair = [
      ...threadMessages(s.calls()),
      ...ofKind(s.calls(), "dm.sent")
        .filter((d) => d.detail["to"] !== SAFEGUARDING_CONTACT)
        .map((d) => String(d.detail["body"])),
    ];
    expect(toPair.filter((b) => /safeguard|disclosure/i.test(b))).toEqual([]);
    // No feedback survey either: it is not a session to rate.
    expect(toPair.filter((b) => b.startsWith("Was that session useful?"))).toEqual([]);
  });

  it(`keeps the program moving (${journey.name})`, () => {
    const { log } = get();
    expect(agreementsOpened(log)).toHaveLength(2);
  });
}

describe("journey: safeguarding", () => {
  let s: Stage;
  let log: StageEvent[];
  beforeAll(async () => {
    s = await runJourney(safeguarding);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("reaches the named contact out of band, by DM, with the summary", () => {
    const toContact = ofKind(s.calls(), "dm.sent").filter(
      (d) => d.detail["to"] === SAFEGUARDING_CONTACT,
    );
    expect(toContact).toHaveLength(1);
    expect(String(toContact[0]!.detail["body"])).toMatch(/^Safeguarding flag raised on session /);
  });

  neverReachesThePair(safeguarding, () => ({ s, log }));
});

describe("journey: safeguarding-unconfigured", () => {
  let s: Stage;
  let log: StageEvent[];
  beforeAll(async () => {
    s = await runJourney(safeguardingUnconfigured);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("warns loudly instead of dropping it, and DMs nobody", () => {
    expect(
      s.logs().filter((l) => l.includes("safeguarding flagged with no contact configured")),
    ).toHaveLength(1);
    expect(
      ofKind(s.calls(), "dm.sent").filter((d) => /safeguard/i.test(String(d.detail["body"]))),
    ).toEqual([]);
  });

  neverReachesThePair(safeguardingUnconfigured, () => ({ s, log }));
});

describeProperties(safeguarding);
describeProperties(safeguardingUnconfigured);
