import { defineJourney } from "../harness/journey.js";
import { named } from "../harness/observe.js";
import type { Stage } from "../harness/stage.js";
import { reachConfirming } from "./steps.js";

/**
 * ADR-0005: the database is the source of truth and the shared doc is a
 * projection — but a human edit inside the managed region is theirs, and the
 * next render must not clobber it. An echo of our own write (the vendor
 * normalising what we wrote) is not a human edit and must not pin.
 *
 * The next render after `confirming` is the auto-confirm's unverified marker,
 * so both journeys let the confirmation time out. The edit itself is made the
 * way a person would make it: in the document, at the vendor.
 */
async function docRefOf(s: Stage): Promise<string> {
  const [rendered] = named(await s.events(), "document.rendered");
  return String(rendered!.payload["docRef"]);
}

export const HUMAN_EDIT = "## Our notes\n\n- Priya owns the draft; Arjun reviews Friday.";

export const documentPinned = defineJourney({
  name: "document-pinned",
  script: async (s) => {
    await reachConfirming(s);
    s.vendor.document!.humanEdit(await docRefOf(s), HUMAN_EDIT);
    s.advanceBy({ hours: 120, minutes: 1 });
    await s.drain();
  },
});

export const documentEcho = defineJourney({
  name: "document-echo",
  script: async (s) => {
    await reachConfirming(s);
    // Google re-wrapped a line of what we wrote: still ours.
    s.vendor.document!.simulateServiceEcho(await docRefOf(s), "## Session summary\n\n(re-flowed)");
    s.advanceBy({ hours: 120, minutes: 1 });
    await s.drain();
  },
});
