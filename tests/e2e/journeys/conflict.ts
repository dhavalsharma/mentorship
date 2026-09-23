import { defineJourney } from "../harness/journey.js";
import { accept, latestAgreement } from "../harness/observe.js";

/**
 * Both say yes — to different slots. The resolver calls that a conflict, not
 * an agreement, and the saga says who picked what before re-offering the two
 * picked slots; the pair then converges on one and it is booked.
 */
export const conflict = defineJourney({
  name: "conflict",
  script: async (s) => {
    await s.drain();
    const round1 = await latestAgreement(s);
    await accept(s, s.mentor, round1.agreementId, round1.options[0]!.optionId);
    await s.drain();
    await accept(s, s.mentee, round1.agreementId, round1.options[1]!.optionId);
    await s.drain();

    const round2 = await latestAgreement(s);
    await accept(s, s.mentor, round2.agreementId, round2.options[1]!.optionId);
    await s.drain();
    await accept(s, s.mentee, round2.agreementId, round2.options[1]!.optionId);
    await s.drain();
  },
});
