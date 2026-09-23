import { defineJourney } from "../harness/journey.js";

/**
 * Nobody answers. Policy defaults: the proposal times out at 48h, the saga
 * renudges once and waits another 48h, and at 96h with still no reply it
 * pauses for a human. Invariant 11 — never a third attempt at the same
 * silence — and invariant 9: nothing is booked on nobody's say-so.
 */
export const noResponse = defineJourney({
  name: "no-response",
  script: async (s) => {
    await s.drain();
    s.advanceBy({ hours: 48, minutes: 1 });
    await s.drain();
    s.advanceBy({ hours: 48, minutes: 1 });
    await s.drain();
    // Long after: a paused saga stays paused, and says nothing more.
    s.advanceBy({ days: 30 });
    await s.drain();
  },
});
