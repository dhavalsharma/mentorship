import { defineJourney } from "../harness/journey.js";

/**
 * Two pairs in one roster. The first is India and California, both keeping
 * 09:00–18:00 locally: there is no mutual working hour, and saying so beats
 * proposing 03:00. The second is India and London, which overlap 09:00–12:30Z
 * — the check that what *is* offered sits inside both people's day
 * (invariant 21: availability is instants, and offsets are applied per
 * person, not assumed shared).
 */
export const NO_OVERLAP_ROSTER = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun@example.com,Arjun Rao,sam@example.com,Sam Lee,fortnightly,U-ARJUN,U-SAM,+05:30,-08:00",
  "meera@example.com,Meera Iyer,ola@example.com,Ola Berg,fortnightly,U-MEERA,U-OLA,+05:30,+00:00",
].join("\n");

export const WORKING_OFFSETS: Record<number, [number, number]> = {
  0: [330, -480],
  1: [330, 0],
};

export const noMutualAvailability = defineJourney({
  name: "no-mutual-availability",
  options: { roster: NO_OVERLAP_ROSTER },
  script: async (s) => {
    await s.drain();
    s.advanceBy({ days: 30 });
    await s.drain();
  },
});
