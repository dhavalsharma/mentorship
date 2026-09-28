import { expect } from "vitest";
import { defineJourney } from "../harness/journey.js";
import { latestAgreement, submitCounter, suggestAnother } from "../harness/observe.js";

/**
 * "Suggest another" through the real modal, twice. The first counter opens
 * round 2 leading with the suggested time; the second meets the two-round
 * cap (invariant 10) and a human is asked to help. The counter is a
 * datepicker + timepicker in the submitter's own zone, converted to an
 * instant (invariant 21) — never parsed out of prose (invariant 9).
 */
export const counterThenCap = defineJourney({
  name: "counter-then-cap",
  script: async (s) => {
    await s.drain();
    const round1 = await latestAgreement(s);

    await suggestAnother(s, s.mentor, round1.agreementId);
    // Arjun is on +05:30: 10:00 his time on Thursday is 04:30Z.
    const res1 = await submitCounter(s, s.mentor, { date: "2026-09-17", time: "10:00" });
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe("");
    await s.drain();

    const round2 = await latestAgreement(s);
    expect(round2.round).toBe(2);

    await suggestAnother(s, s.mentee, round2.agreementId);
    const res2 = await submitCounter(s, s.mentee, { date: "2026-09-18", time: "15:00" });
    expect(res2.status).toBe(200);
    await s.drain();

    s.advanceBy({ days: 30 });
    await s.drain();
  },
});
