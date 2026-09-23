import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { describeProperties } from "./harness/properties.js";
import {
  agreementsOpened,
  escalations,
  kinds,
  named,
  names,
  ofKind,
  threadMessages,
} from "./harness/observe.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { happyPath, SESSION_NOTES } from "./journeys/happy-path.js";

describe("journey: happy-path", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(happyPath);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  // Bug #10: capabilities reach the resolver only through the worker's boot
  // probe now — the seed no longer writes them. A miss on a bound slot is
  // logged, so a clean log is the proof the probe path wrote every slot.
  it("reads every bound slot's capabilities from the boot probe, with no cache miss", () => {
    expect(s.logs().filter((l) => l.includes("capabilit"))).toEqual([]);
  });

  it("walks the whole loop, in order, and ends proposing the next session", () => {
    const milestones = names(log).filter((n) =>
      [
        "pair.activated",
        "agreement.opened",
        "agreement.responded",
        "session.scheduled",
        "session.reminded",
        "session.held",
        "notes.submitted",
        "extraction.completed",
        "document.rendered",
        "extraction.confirmed",
        "survey.unanswered",
        "pair.cadence_deficit",
      ].includes(n),
    );
    expect(milestones).toEqual([
      "pair.activated",
      "agreement.opened",
      "agreement.responded",
      "agreement.responded",
      "session.scheduled",
      "session.reminded",
      "session.held",
      "notes.submitted",
      "extraction.completed",
      "document.rendered",
      "extraction.confirmed",
      "extraction.confirmed",
      "survey.unanswered",
      "survey.unanswered",
      "pair.cadence_deficit",
      "agreement.opened",
    ]);
    const [first, second] = agreementsOpened(log);
    expect(second!.round).toBe(1);
    expect(second!.agreementId).not.toBe(first!.agreementId);
    expect(escalations(log)).toEqual([]);
  });

  it("delivered every event and dead-lettered none", () => {
    expect(log.every((e) => e.relayed)).toBe(true);
    expect(log.some((e) => e.deadLettered)).toBe(false);
  });

  it("booked exactly one invite, for the slot both picked (invariant 5)", () => {
    const booked = ofKind(s.calls(), "calendar.created");
    expect(booked).toHaveLength(1);
    const [first] = agreementsOpened(log);
    const scheduled = named(log, "session.scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload["startsAt"]).toBe(first!.options[0]!.startsAt);
    // The calendar id the saga holds is the one the adapter returned.
    expect(scheduled[0]!.payload["calendarEventId"]).toBe(booked[0]!.detail["eventId"]);
  });

  it("said what happened in the thread at each step", () => {
    const thread = threadMessages(s.calls());
    expect(thread.some((b) => b.startsWith("Arjun Rao picked"))).toBe(true);
    expect(thread.some((b) => b.startsWith("Booked —"))).toBe(true);
    expect(thread.some((b) => b.startsWith("Reminder:"))).toBe(true);
    expect(thread.some((b) => b.startsWith("How did it go?"))).toBe(true);
    expect(thread).toContain("Arjun Rao confirmed the write-up. Waiting on Priya Menon.");
    expect(ofKind(s.calls(), "thread.proposal")).toHaveLength(2);
  });

  it("extracted from the notes verbatim and landed them pending, then confirmed by button (invariants 9, 19)", () => {
    const [notes] = named(log, "notes.submitted");
    expect(notes!.payload["body"]).toBe(SESSION_NOTES);
    const [extraction] = named(log, "extraction.completed");
    expect(String(extraction!.payload["markdown"])).toContain("not yet reviewed");
    // Both verdicts came from the button and carry who clicked; none is unverified.
    const confirmed = named(log, "extraction.confirmed");
    expect(confirmed.map((e) => e.payload["unverified"] ?? false)).toEqual([false, false]);
    expect(new Set(confirmed.map((e) => e.payload["participantId"])).size).toBe(2);
  });

  it("sent private things privately: reminders and feedback requests as DMs, never to the thread (invariant 13)", () => {
    const dms = ofKind(s.calls(), "dm.sent");
    // Two heads-up DMs at the reminder, two feedback questions.
    expect(dms).toHaveLength(4);
    expect(dms.filter((d) => String(d.detail["body"]).startsWith("Was that session useful?"))).toHaveLength(2);
    expect(threadMessages(s.calls()).some((b) => b.startsWith("Was that session useful?"))).toBe(false);
  });

  it("touched the outside world in a sensible order", () => {
    const k = kinds(s.calls());
    expect(k.indexOf("thread.created")).toBeLessThan(k.indexOf("thread.proposal"));
    expect(k.indexOf("calendar.created")).toBeLessThan(k.indexOf("document.rendered"));
    expect(k.indexOf("document.rendered")).toBeLessThan(k.indexOf("thread.confirmation"));
  });
});

describeProperties(happyPath);
