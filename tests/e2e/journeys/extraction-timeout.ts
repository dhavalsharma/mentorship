import { defineJourney } from "../harness/journey.js";
import { reachConfirming } from "./steps.js";

/**
 * Nobody presses Confirm or Edit. After `autoConfirmAfterHours` (120) the
 * extraction is confirmed anyway — and marked unverified, in the event and in
 * the document, because a timeout must never silently promote a machine guess
 * to agreed fact (invariant 19).
 */
export const extractionTimeout = defineJourney({
  name: "extraction-timeout",
  script: async (s) => {
    await reachConfirming(s);
    s.advanceBy({ hours: 120, minutes: 1 });
    await s.drain();
  },
});
