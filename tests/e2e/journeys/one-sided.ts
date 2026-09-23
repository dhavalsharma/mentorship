import { defineJourney } from "../harness/journey.js";
import { accept, latestAgreement } from "../harness/observe.js";

/**
 * One party picks a slot; the other never answers. Under the default
 * `require_both` resolution nothing may be booked, and the silent party is
 * owed exactly one renudge before a human is pulled in (invariant 11).
 */
export const oneSided = defineJourney({
  name: "one-sided",
  script: async (s) => {
    await s.drain();
    const agreement = await latestAgreement(s);
    await accept(s, s.mentor, agreement.agreementId, agreement.options[0]!.optionId);
    await s.drain();
    s.advanceBy({ hours: 48, minutes: 1 });
    await s.drain();
    s.advanceBy({ hours: 48, minutes: 1 });
    await s.drain();
    s.advanceBy({ days: 30 });
    await s.drain();
  },
});
