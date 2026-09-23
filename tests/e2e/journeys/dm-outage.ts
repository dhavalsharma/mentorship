import { defineJourney } from "../harness/journey.js";
import { hoursAfter, say } from "../harness/observe.js";
import { bookFirstSlot, NOTES } from "./steps.js";

/**
 * The DM vendor is down for the whole session: bound, probed healthy, and
 * every send fails. Invariant 13 is the part that must hold unconditionally —
 * a private message never falls back to the joint thread — but a DM outage
 * is a partial outage, and the rest of the session should survive it.
 *
 * Drains are tolerant: this journey means to watch failures.
 */
export const dmOutage = defineJourney({
  name: "dm-outage",
  options: { adapters: { dm: "down" } },
  script: async (s) => {
    const slot = await bookFirstSlot(s);
    s.advanceTo(hoursAfter(slot.startsAt, -24));
    await s.drain({ tolerate: true });
    s.advanceTo(hoursAfter(slot.endsAt, 0.25));
    await s.drain({ tolerate: true });
    await say(s, s.mentee, NOTES);
    await s.drain({ tolerate: true });
    s.advanceBy({ hours: 121 });
    await s.drain({ tolerate: true });
  },
});
