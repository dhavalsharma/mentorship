import { defineJourney } from "../harness/journey.js";
import { accept, hoursAfter, latestAgreement, say } from "../harness/observe.js";
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

/**
 * The same outage on a tenant with no conversation slot: there is no thread,
 * so every *shared* message — the proposal, the booked confirmation, the
 * reminder — is a DM to each party, and every one of them fails. Each is
 * retried once (the relay's redelivery, or the tick's backed-off retry), then
 * degrades to `dm_undeliverable` per recipient and the step completes: the
 * pair is escalated to a human straight away rather than parked five
 * attempts later, and the saga stays live for the clicks that still arrive.
 *
 * Each `advanceBy` is the wait for that retry to come due.
 */
export const dmOutageNoThread = defineJourney({
  name: "dm-outage-no-thread",
  options: { adapters: { dm: "down", conversation: false } },
  script: async (s) => {
    await s.drain({ tolerate: true }); // the proposal: every DM fails
    s.advanceBy({ minutes: 10 });
    await s.drain({ tolerate: true }); // redelivered: degrades, proposing
    const agreement = await latestAgreement(s);
    const slot = agreement.options[0]!;
    await accept(s, s.mentor, agreement.agreementId, slot.optionId);
    await s.drain({ tolerate: true });
    await accept(s, s.mentee, agreement.agreementId, slot.optionId);
    await s.drain({ tolerate: true }); // booked; the confirmation DM fails
    s.advanceBy({ minutes: 10 });
    await s.drain({ tolerate: true });
    s.advanceTo(hoursAfter(slot.startsAt, -24));
    await s.drain({ tolerate: true }); // the reminder fails
    s.advanceBy({ minutes: 10 });
    await s.drain({ tolerate: true }); // retried: degrades, reminded
  },
});
