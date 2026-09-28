import { defineJourney } from "../harness/journey.js";
import { hoursAfter, verdict, lastConfirmationRequest } from "../harness/observe.js";
import { reachHeld } from "./steps.js";

/**
 * Whether the saga waits for a transcript at all is a *flow* branch, decided
 * by probed capability and every party's recording consent (ADR-0006,
 * invariant 12) — not a runner degradation. Three tenants, same script:
 *
 *   - no transcript slot at all: never polls, asks for notes, and with none
 *     arriving records the session as undocumented and cools down;
 *   - a native-transcription tenant whose participants never consented to
 *     recording: exactly the same as having no transcription;
 *   - native transcription with both consents: the invite says it will be
 *     transcribed, the saga polls, and the extraction comes from the
 *     transcript without anyone typing notes.
 */
export const noTranscription = defineJourney({
  name: "no-transcription",
  script: async (s) => {
    const slot = await reachHeld(s);
    // The manual-notes window (72h) passes in silence.
    s.advanceTo(hoursAfter(slot.endsAt, 0.25 + 72 + 0.1));
    await s.drain();
    // Cooling counts from the session's end: due in 14 days, proposing 5 early.
    s.advanceTo(hoursAfter(slot.endsAt, 9 * 24 + 1));
    await s.drain();
  },
});

export const transcriptionWithoutConsent = defineJourney({
  name: "transcription-without-consent",
  options: {
    adapters: { transcript: { autoTranscription: "native" } },
    consents: { recording: false },
  },
  script: noTranscription.script,
});

export const transcribed = defineJourney({
  name: "transcribed",
  options: {
    adapters: { transcript: { autoTranscription: "native", availableAfterFetches: 2 } },
    consents: { recording: true },
  },
  script: async (s) => {
    const slot = await reachHeld(s);
    // First poll (end + 15m) finds nothing; the backoff's next is end + 60m.
    s.advanceTo(hoursAfter(slot.endsAt, 1.1));
    await s.drain();
    const { extractionId } = lastConfirmationRequest(s.calls());
    await verdict(s, s.mentor, extractionId, "confirm");
    await verdict(s, s.mentee, extractionId, "edit");
    await s.drain();
  },
});
