import { expect } from "vitest";
import { defineJourney } from "../harness/journey.js";
import {
  accept,
  hoursAfter,
  lastConfirmationRequest,
  latestAgreement,
  say,
  verdict,
} from "../harness/observe.js";

export const SESSION_NOTES = [
  "Priya: I'll draft the internal application this week.",
  "Arjun: Send me the draft by Friday and I'll review it.",
  "Priya: Next time let's make estimating the topic.",
].join("\n");

/**
 * The whole loop, through the doors a human has.
 *
 * One honest gap shapes the feedback step: there is no inbound route for a
 * feedback answer. `feedback.submitted` is in `EVENT_NAMES` and the saga
 * waits on it, but nothing in `apps/api` writes it — so the only way out of
 * `feedback` is its window closing, which emits `survey.unanswered` for each
 * party. The journey takes that path because it is the only one that exists.
 */
export const happyPath = defineJourney({
  name: "happy-path",
  script: async (s) => {
    // pair.activated (seeded) -> propose.
    await s.drain();
    const first = await latestAgreement(s);
    expect(first.round).toBe(1);
    expect(first.options.length).toBeGreaterThan(0);
    const slot = first.options[0]!;

    // Both accept the same slot -> book -> the invite id comes back as an event.
    // Drained in between, as two people clicking minutes apart would be: the
    // first pick is announced before the second arrives.
    await accept(s, s.mentor, first.agreementId, slot.optionId);
    await s.drain();
    await accept(s, s.mentee, first.agreementId, slot.optionId);
    await s.drain();

    // The reminder fires reminderLeadHours (24) before the start.
    s.advanceTo(hoursAfter(slot.startsAt, -24));
    await s.drain();

    // The meeting ends; with no transcription the pair is asked for notes.
    s.advanceTo(hoursAfter(slot.endsAt, 0.25));
    await s.drain();

    // Notes typed into the thread -> extract -> render -> ask for confirmation.
    await say(s, s.mentee, SESSION_NOTES);
    await s.drain();
    const { extractionId } = lastConfirmationRequest(s.calls());

    await verdict(s, s.mentor, extractionId, "confirm");
    await s.drain();
    await verdict(s, s.mentee, extractionId, "confirm");
    await s.drain();

    // Feedback window (72h) closes unanswered -> cooling.
    s.advanceBy({ hours: 72, minutes: 1 });
    await s.drain();

    // Cooling wakes proposeLeadDays (5) before the fortnight is due.
    s.advanceBy({ days: 9, minutes: 1 });
    await s.drain();
  },
});
