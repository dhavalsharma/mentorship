import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { named } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { strangerNotes } from "./journeys/notes.js";
import { NOTES } from "./journeys/steps.js";

describe("journey: stranger-notes", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(strangerNotes);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("records only the pair's own words as the pair's notes (invariant 15)", () => {
    const notes = named(log, "notes.submitted");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload["body"]).toBe(NOTES);
    expect(notes[0]!.subjectRef).toBe(`pairing:${s.pairingIds[0]}`);
  });

  it("says why it refused, where an operator will see it", () => {
    expect(s.logs().some((l) => l.includes("participant_not_in_pair"))).toBe(true);
    expect(s.logs().some((l) => l.includes("unmapped_identity"))).toBe(true);
  });

  it("does not let a stranger's click confirm someone else's session", () => {
    expect(named(log, "extraction.confirmed")).toEqual([]);
    expect(s.logs().some((l) => l.includes("extraction_respond_failed"))).toBe(true);
  });

  it("never flags safeguarding on a stranger's say-so", () => {
    expect(named(log, "safeguarding.flagged")).toEqual([]);
  });
});

describeProperties(strangerNotes);
