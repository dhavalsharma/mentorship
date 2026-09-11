import type { Cadence, PairingOrigin, PairingState } from "@mentorship/core";
import type { ImportPlan, PlannedPair, PlannedPerson } from "./import.js";
import { planIsCommittable } from "./import.js";

/**
 * Committing a plan is deliberately a separate step from building it, and it
 * writes through a narrow sink so the importer never depends on the database.
 */
export interface RosterSink {
  upsertPerson(person: PlannedPerson): Promise<{ participantId: string }>;
  createPairing(input: {
    pairKey: string;
    mentorParticipantId: string;
    menteeParticipantId: string;
    state: PairingState;
    origin: PairingOrigin;
    cadenceOverride: Partial<Cadence> | null;
    startsAt: string | null;
    notes: string | null;
    importFileHash: string;
  }): Promise<{ pairingId: string }>;
  /** Called once per created pair, after the row is written. */
  announce(input: {
    pairingId: string;
    state: PairingState;
    participantIds: string[];
  }): Promise<void>;
}

export interface CommitResult {
  created: { rowNumber: number; pairingId: string }[];
  peopleCreated: number;
  /** True when errors were present and `allowPartial` let the good rows through. */
  partial: boolean;
}

export async function commitRosterImport(
  plan: ImportPlan,
  sink: RosterSink,
  opts: {
    /** `active` goes straight into the session lifecycle; `offered` waits for both to accept. */
    importedPairsStart: PairingState;
    allowPartial?: boolean;
  },
): Promise<CommitResult> {
  if (!planIsCommittable(plan, opts)) {
    throw new Error(
      `plan is not committable: ${plan.errors.length} error(s), ${plan.creates.length} pair(s) to create`,
    );
  }

  const participantIds = new Map<string, string>();
  for (const person of plan.newPeople) {
    const { participantId } = await sink.upsertPerson(person);
    participantIds.set(person.email, participantId);
  }

  const created: CommitResult["created"] = [];
  for (const pair of plan.creates) {
    const mentorId = await resolve(pair.mentor);
    const menteeId = await resolve(pair.mentee);

    const { pairingId } = await sink.createPairing({
      pairKey: pair.pairKey,
      mentorParticipantId: mentorId,
      menteeParticipantId: menteeId,
      state: opts.importedPairsStart,
      origin: pair.origin,
      cadenceOverride: pair.cadenceOverride,
      startsAt: pair.startsAt,
      notes: pair.notes,
      importFileHash: plan.fileHash,
    });

    // The same announcement a matched pair makes. Nothing downstream can tell
    // that this one came out of a spreadsheet — which is the whole point.
    await sink.announce({
      pairingId,
      state: opts.importedPairsStart,
      participantIds: [mentorId, menteeId],
    });

    created.push({ rowNumber: pair.rowNumber, pairingId });
  }

  return {
    created,
    peopleCreated: plan.newPeople.length,
    partial: plan.errors.length > 0,
  };

  async function resolve(person: PlannedPerson): Promise<string> {
    const known = participantIds.get(person.email);
    if (known) return known;
    const { participantId } = await sink.upsertPerson(person);
    participantIds.set(person.email, participantId);
    return participantId;
  }
}

/** Convenience: the pair of a plan's created rows, for logging. */
export function describePair(pair: PlannedPair): string {
  return `${pair.mentor.displayName} -> ${pair.mentee.displayName}`;
}
