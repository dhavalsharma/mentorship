import { describe, it } from "vitest";

/**
 * `declined` — INFEASIBLE with current code, so skipped rather than faked.
 *
 * `resolveAgreement` has a `declined` outcome and the saga pauses on it, but
 * no human door produces a decline: the proposal renders only option buttons
 * and "Suggest another" (`SlackConversationAdapter.postProposal`), and
 * `parseSlackInteractionPayload` rejects any `kind` other than `accept` /
 * `counter` as unrecognised. The outcome is reachable only by writing an
 * `agreements.responses` row directly, which is exactly what a journey may
 * not do. Build a Decline button (and its parser case) and this becomes a
 * five-line journey: pause `declined`, nothing booked, one escalation.
 */
describe("journey: declined", () => {
  it.skip("pauses with declined and books nothing — no decline door exists yet", () => {});
});
