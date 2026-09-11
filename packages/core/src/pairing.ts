import { z } from "zod";

export const PairingStateSchema = z.enum([
  "proposed",
  "offered",
  "accepted",
  "active",
  "paused",
  "completed",
  "ended_early",
]);
export type PairingState = z.infer<typeof PairingStateSchema>;

/**
 * How this pair came to exist. The point of recording it: an imported pair and
 * a matched pair are indistinguishable to everything downstream, which is what
 * makes matching genuinely optional rather than merely skippable.
 */
export const PairingOriginSchema = z.enum([
  "imported", // from a roster spreadsheet
  "manual", // an admin created it
  "matched", // the matching primitive proposed it, a human approved
  "self_select", // the mentee requested it
]);
export type PairingOrigin = z.infer<typeof PairingOriginSchema>;

const TRANSITIONS: Record<PairingState, PairingState[]> = {
  proposed: ["offered", "active", "ended_early"],
  offered: ["accepted", "ended_early"],
  accepted: ["active", "ended_early"],
  active: ["paused", "completed", "ended_early"],
  paused: ["active", "completed", "ended_early"],
  completed: [],
  ended_early: [],
};

export function canTransition(from: PairingState, to: PairingState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: PairingState, to: PairingState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal pairing transition: ${from} -> ${to}`);
  }
}

/** Terminal states carry no saga; the engine ends the instance. */
export function isTerminal(state: PairingState): boolean {
  return state === "completed" || state === "ended_early";
}
