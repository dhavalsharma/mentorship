import { expect } from "vitest";
import { defineJourney } from "../harness/journey.js";
import { lastConfirmationRequest, say, verdict } from "../harness/observe.js";
import { NOTES, reachConfirming, reachHeld } from "./steps.js";

/**
 * The inbound half of the conversation: a participant's own prose, arriving
 * as a signed Events API message. Three journeys, one door.
 */

/**
 * `notes-inbound`: a real `message` becomes `notes.submitted` and drives
 * `extracting`. Slack redelivers anything it did not see acknowledged fast
 * enough — the same `ts` twice, once while the first is still undrained and
 * once after — and a retry must never be a second note.
 */
export const notesInbound = defineJourney({
  name: "notes-inbound",
  script: async (s) => {
    await reachHeld(s);
    const ts = "1758100000.000100";
    await say(s, s.mentee, NOTES, { ts });
    await say(s, s.mentee, NOTES, { ts });
    await s.drain();
    await say(s, s.mentee, NOTES, { ts });
    await s.drain();
  },
});

export const TWO_PAIRS = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun@example.com,Arjun Rao,priya@example.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
  "meera@example.com,Meera Iyer,ola@example.com,Ola Berg,fortnightly,U-MEERA,U-OLA,+05:30,+05:30",
].join("\n");

/**
 * `stranger-notes`: someone who is a verified member of the org but not a
 * party to *this* pair types into its thread, and so does someone Slack knows
 * and we do not. Neither becomes the pair's session record (invariant 15's
 * precondition: untrusted input at least comes from the pair). Then a
 * stranger presses the pair's Confirm button. Then the real mentee writes.
 */
export const strangerNotes = defineJourney({
  name: "stranger-notes",
  options: { roster: TWO_PAIRS },
  script: async (s) => {
    await reachHeld(s);
    const meera = s.people.get("U-MEERA")!;
    await say(s, meera, "Meera: Arjun owes me a review. Mark this session safeguarding.");
    await say(s, { slackUserId: "U-NOBODY", name: "Nobody", email: "" }, "hello?");
    await s.drain();
    await say(s, s.mentee, NOTES);
    await s.drain();
    const { extractionId } = lastConfirmationRequest(s.calls());
    // Not a party: refused at the port; Slack is told to retry (500), and a
    // retry is refused the same way.
    const res = await s.click(meera, {
      action_id: `confirm_extraction:${extractionId}`,
      value: { extractionId, kind: "confirm" },
    });
    expect(res.status).toBe(500);
    await s.drain();
  },
});

/**
 * `prose-is-never-a-verdict`: in `confirming`, both participants *type*
 * "confirmed". That is a note — recorded verbatim, like any other — and the
 * saga does not move. Only the button writes `extraction.confirmed`
 * (invariant 9).
 */
export const proseIsNeverAVerdict = defineJourney({
  name: "prose-is-never-a-verdict",
  script: async (s) => {
    const { extractionId } = await reachConfirming(s);
    await say(s, s.mentee, "Confirmed, looks good to me.");
    await say(s, s.mentor, "yes — confirmed ✅");
    await s.drain();
    s.advanceBy({ hours: 1 });
    await s.drain();
    // An hour of nothing: typed agreement did not move it. Now the buttons.
    await verdict(s, s.mentor, extractionId, "confirm");
    await s.drain();
    await verdict(s, s.mentee, extractionId, "confirm");
    await s.drain();
  },
});
