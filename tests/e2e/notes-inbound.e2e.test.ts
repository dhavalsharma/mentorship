import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { named, ofKind } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { notesInbound } from "./journeys/notes.js";
import { NOTES } from "./journeys/steps.js";

describe("journey: notes-inbound", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(notesInbound);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("turns a signed message into exactly one notes.submitted, however often Slack retries", () => {
    const notes = named(log, "notes.submitted");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload["body"]).toBe(NOTES);
    expect(notes[0]!.payload["noteId"]).toBe("1758100000.000100");
  });

  it("drives one extraction from the note's own words", () => {
    const extractions = named(log, "extraction.completed");
    expect(extractions).toHaveLength(1);
    const items = extractions[0]!.payload["actionItems"] as string[];
    expect(items.some((i) => i.includes("draft the internal application"))).toBe(true);
    expect(ofKind(s.calls(), "thread.confirmation")).toHaveLength(1);
  });
});

describeProperties(notesInbound);
