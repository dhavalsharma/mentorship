import { describe, it } from "vitest";

/**
 * `consent-revoked` — INFEASIBLE with current code, so skipped rather than
 * faked.
 *
 * Invariant 12 says revoking recording consent must change the *next* invite.
 * The read side is ready — `PostgresSagaResolvers` treats a `revoked_at` as
 * not granted, and `book()` derives `withTranscription` from current consent
 * — but nothing lets a participant revoke: there is no route, no Slack
 * control, and no writer of `consents.revoked_at` anywhere in the repo. The
 * half that *is* reachable is covered: `transcription-without-consent` and
 * `transcribed` (no-transcription.e2e.test.ts) show consent deciding both the
 * invite's recording line and whether the saga polls at all.
 */
describe("journey: consent-revoked", () => {
  it.skip("revoking recording consent changes the next invite — no revocation door exists yet", () => {});
});
