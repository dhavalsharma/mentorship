import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney, type Journey } from "./harness/journey.js";
import {
  agreementsOpened,
  escalations,
  named,
  ofKind,
  threadMessages,
} from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import {
  noTranscription,
  transcribed,
  transcriptionWithoutConsent,
} from "./journeys/no-transcription.js";

function asksForNotesAndGivesUp(journey: Journey): void {
  describe(`journey: ${journey.name}`, () => {
    let s: Stage;
    let log: StageEvent[];

    beforeAll(async () => {
      s = await runJourney(journey);
      log = await s.events();
    });
    afterAll(async () => {
      await s?.close();
    });

    it("books an invite that says it will not be recorded", () => {
      const [invite] = ofKind(s.calls(), "calendar.created");
      expect(invite!.detail["transcription"]).toBe(false);
    });

    it("never polls for a transcript — a flow branch, not a degraded effect (ADR-0006)", () => {
      expect(ofKind(s.calls(), "transcript.fetch")).toEqual([]);
      expect(named(log, "transcript.available")).toEqual([]);
      expect(threadMessages(s.calls()).some((b) => b.startsWith("How did it go?"))).toBe(true);
    });

    it("records the silent session as undocumented, says so, and lines up the next one", () => {
      expect(named(log, "session.undocumented")).toHaveLength(1);
      expect(threadMessages(s.calls())).toContain(
        "No notes this time — no problem. I'll line up the next session.",
      );
      expect(named(log, "extraction.completed")).toEqual([]);
      expect(agreementsOpened(log)).toHaveLength(2);
      expect(escalations(log)).toEqual([]);
    });
  });
  describeProperties(journey);
}

asksForNotesAndGivesUp(noTranscription);
asksForNotesAndGivesUp(transcriptionWithoutConsent);

describe("journey: transcribed", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(transcribed);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("books an invite that says it will be transcribed, because both consented (invariant 12)", () => {
    const [invite] = ofKind(s.calls(), "calendar.created");
    expect(invite!.detail["transcription"]).toBe(true);
  });

  it("polls on the backoff schedule and extracts from the transcript, with no notes asked for", () => {
    const fetches = ofKind(s.calls(), "transcript.fetch");
    expect(fetches.map((f) => f.detail["found"])).toEqual([false, true]);
    expect(threadMessages(s.calls()).some((b) => b.startsWith("How did it go?"))).toBe(false);
    expect(named(log, "notes.submitted")).toEqual([]);
    const [extraction] = named(log, "extraction.completed");
    expect(String(extraction!.payload["sourceRef"])).toMatch(/^transcript_/);
    // The fake transcript's commitments made it through: the source text was
    // not lost between the fetch and the extraction.
    expect((extraction!.payload["actionItems"] as string[]).length).toBeGreaterThan(0);
  });

  it("takes Edit as a verdict too, and moves on to feedback", () => {
    expect(named(log, "extraction.confirmed")).toHaveLength(1);
    expect(named(log, "extraction.edited")).toHaveLength(1);
    expect(
      ofKind(s.calls(), "dm.sent").filter((d) =>
        String(d.detail["body"]).startsWith("Was that session useful?"),
      ),
    ).toHaveLength(2);
  });
});

describeProperties(transcribed);
