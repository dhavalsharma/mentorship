import { expect } from "vitest";
import {
  accept,
  hoursAfter,
  lastConfirmationRequest,
  latestAgreement,
  say,
  type OpenedAgreement,
} from "../harness/observe.js";
import type { Stage } from "../harness/stage.js";

/**
 * The stretches most journeys share, written once. Each is still only clicks,
 * messages and the clock — a journey that starts from "held" got there the
 * same way a pair would.
 */

export const NOTES = [
  "Priya: I'll draft the internal application this week.",
  "Arjun: Send me the draft by Friday and I'll review it.",
].join("\n");

/** Propose, both accept the first slot (a few minutes apart), book. */
export async function bookFirstSlot(s: Stage): Promise<OpenedAgreement["options"][number]> {
  await s.drain();
  const agreement = await latestAgreement(s);
  const slot = agreement.options[0]!;
  await accept(s, s.mentor, agreement.agreementId, slot.optionId);
  await s.drain();
  await accept(s, s.mentee, agreement.agreementId, slot.optionId);
  await s.drain();
  return slot;
}

/** Booked, reminded, and the meeting over: the saga is waiting for notes (or a transcript). */
export async function reachHeld(s: Stage): Promise<OpenedAgreement["options"][number]> {
  const slot = await bookFirstSlot(s);
  s.advanceTo(hoursAfter(slot.startsAt, -24));
  await s.drain();
  s.advanceTo(hoursAfter(slot.endsAt, 0.25));
  await s.drain();
  return slot;
}

/** Notes in, extracted, rendered, and the Confirm/Edit buttons posted. */
export async function reachConfirming(s: Stage, notes = NOTES): Promise<{ extractionId: string }> {
  await reachHeld(s);
  await say(s, s.mentee, notes);
  await s.drain();
  const request = lastConfirmationRequest(s.calls());
  expect(request.extractionId).toBeTruthy();
  return { extractionId: request.extractionId };
}
