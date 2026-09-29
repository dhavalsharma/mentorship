import {
  PairPreferencesUpdatedPayloadSchema,
  resolveCadence,
  StoredProgramPolicySchema,
  type Cadence,
  type PairPreferences,
  type PairPreferencesUpdatedPayload,
} from "@mentorship/core";

/**
 * The admin view of pairs choosing their own length and rhythm (ADR-0009
 * action 7). The ADR's accepted risk is that a pair can drift away from the
 * program's intended rhythm without an admin noticing; this read model is
 * what lets one notice. Each row is one `pair.preferences_updated` event,
 * set beside the default the program would give that pair if it had never
 * chosen anything.
 *
 * Pure: the Postgres query (`listPairPreferenceChanges` in
 * `postgres-reads.ts`) fetches the rows and hands them here, so validation
 * and the drift comparison are testable without a database.
 */

export interface PairPreferenceCadence {
  sessionMinutes: number;
  everyDays: number;
}

export interface PairPreferenceChange {
  eventId: string;
  occurredAt: string;
  pairingId: string;
  /** Null when the pairing (or its people) no longer resolves in this org. */
  mentorName: string | null;
  menteeName: string | null;
  changedBy: { participantId: string; displayName: string | null };
  /** Exactly the keys the participant touched. */
  changed: PairPreferences;
  /** The pair's cadence after this change. */
  result: PairPreferenceCadence;
  /**
   * What the program + cohort would give this pair with no pair override —
   * resolved from the policy as it is *now*, not as it was when the change
   * was made: the question an admin is asking is "is this pair off the
   * rhythm we intend today". Null when the program's policy does not parse
   * (the same policy the store itself would refuse to resolve).
   */
  programDefault: PairPreferenceCadence | null;
  differsFromProgramDefault: boolean;
}

export interface PairPreferenceChanges {
  changes: PairPreferenceChange[];
  /**
   * Events whose payload failed `PairPreferencesUpdatedPayloadSchema`. Counted
   * rather than 500ing the page: one bad row (a hand-written event, an older
   * writer) should not hide every good one, and a non-zero count tells the
   * admin the list is incomplete instead of silently dropping it.
   */
  skipped: number;
}

export interface RawPreferenceEvent {
  id: string;
  occurredAt: Date;
  payload: unknown;
}

export interface ValidPreferenceEvent {
  id: string;
  occurredAt: Date;
  payload: PairPreferencesUpdatedPayload;
}

export function parsePreferenceEvents(rows: readonly RawPreferenceEvent[]): {
  valid: ValidPreferenceEvent[];
  skipped: number;
} {
  const valid: ValidPreferenceEvent[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = PairPreferencesUpdatedPayloadSchema.safeParse(row.payload);
    if (parsed.success) valid.push({ id: row.id, occurredAt: row.occurredAt, payload: parsed.data });
    else skipped++;
  }
  return { valid, skipped };
}

export interface PreferenceLookups {
  pairings: ReadonlyMap<
    string,
    { cohortId: string; mentorParticipantId: string; menteeParticipantId: string }
  >;
  /** participant id → the user's display name. */
  names: ReadonlyMap<string, string>;
  /** cohort id → the program policy and cohort cadence override, both raw jsonb. */
  cohorts: ReadonlyMap<string, { policy: unknown; cadenceOverride: unknown }>;
}

/**
 * The program's default for a cohort — program policy then cohort override,
 * deliberately without the pair's own override, since that is the thing
 * being compared against.
 */
export function programDefaultCadence(cohort: {
  policy: unknown;
  cadenceOverride: unknown;
}): PairPreferenceCadence | null {
  const policy = StoredProgramPolicySchema.safeParse(cohort.policy);
  if (!policy.success) return null;
  try {
    const cadence = resolveCadence(
      policy.data.cadence,
      (cohort.cadenceOverride ?? null) as Partial<Cadence> | null,
    );
    return { sessionMinutes: cadence.sessionMinutes, everyDays: cadence.everyDays };
  } catch {
    // A cohort override outside the cadence bounds: no honest default to show.
    return null;
  }
}

export function shapePairPreferenceChanges(
  events: readonly ValidPreferenceEvent[],
  lookups: PreferenceLookups,
): PairPreferenceChange[] {
  const defaults = new Map<string, PairPreferenceCadence | null>();
  const defaultFor = (cohortId: string): PairPreferenceCadence | null => {
    if (!defaults.has(cohortId)) {
      const cohort = lookups.cohorts.get(cohortId);
      defaults.set(cohortId, cohort ? programDefaultCadence(cohort) : null);
    }
    return defaults.get(cohortId) ?? null;
  };

  return events.map(({ id, occurredAt, payload }) => {
    const pairing = lookups.pairings.get(payload.pairingId);
    const programDefault = pairing ? defaultFor(pairing.cohortId) : null;
    const result = { sessionMinutes: payload.sessionMinutes, everyDays: payload.everyDays };
    return {
      eventId: id,
      occurredAt: occurredAt.toISOString(),
      pairingId: payload.pairingId,
      mentorName: pairing ? (lookups.names.get(pairing.mentorParticipantId) ?? null) : null,
      menteeName: pairing ? (lookups.names.get(pairing.menteeParticipantId) ?? null) : null,
      changedBy: {
        participantId: payload.participantId,
        displayName: lookups.names.get(payload.participantId) ?? null,
      },
      changed: payload.changed,
      result,
      programDefault,
      differsFromProgramDefault:
        programDefault !== null &&
        (programDefault.sessionMinutes !== result.sessionMinutes ||
          programDefault.everyDays !== result.everyDays),
    };
  });
}
