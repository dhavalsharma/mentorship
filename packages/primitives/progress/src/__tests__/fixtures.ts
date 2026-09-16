import { addDays, defaultPolicy } from "@mentorship/core";
import {
  PairObservationsSchema,
  type PairObservations,
} from "../observations.js";

/**
 * One fixed instant for every test in this package. Health is a function of
 * observations and a clock; pinning the clock is what lets a test assert an
 * exact number instead of a range.
 */
export const AS_OF = "2026-09-15T12:00:00.000Z";

export const at = (daysAgo: number): string => addDays(AS_OF, -daysAgo);

/** Two participants, referenced only by id — no names to leak anywhere. */
export const MENTOR = "participant_mentor_9f2";
export const MENTEE = "participant_mentee_4c7";

export function observations(
  over: Partial<PairObservations> = {},
): PairObservations {
  const policy = defaultPolicy({});
  return PairObservationsSchema.parse({
    orgId: "org_1",
    pairingId: "p_001",
    asOf: AS_OF,
    startedAt: at(90),
    policy,
    cadence: policy.cadence,
    participantCount: 2,
    sessions: [],
    actionItems: [],
    goals: [],
    activity: [],
    surveys: [],
    responseLatencies: [],
    nextSessionAt: null,
    mentorPortfolio: [],
    ...over,
  });
}

/** Sessions held every `everyDays`, counting back from `asOf`. */
export function heldSessions(count: number, everyDays = 14) {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `s_${i}`,
    at: at(everyDays * i + 1),
    outcome: "held" as const,
  }));
}

/**
 * A pair everything has gone right for: on cadence, action items closed,
 * goals on pace, balanced effort, good ratings, quick replies, next session
 * already booked.
 */
export function healthyObservations(
  over: Partial<PairObservations> = {},
): PairObservations {
  return observations({
    sessions: heldSessions(6),
    actionItems: Array.from({ length: 5 }, (_, i) => ({
      id: `a_${i}`,
      createdAt: at(30 - i),
      closedAt: at(20 - i),
      dueAt: null,
    })),
    goals: [
      {
        goalId: "g_1",
        openedAt: at(50),
        targetAt: addDays(AS_OF, 50),
        checkIns: [
          { at: at(30), progress: 0.3 },
          { at: at(5), progress: 0.6 },
        ],
      },
    ],
    activity: [
      { at: at(10), actorRef: MENTOR, actorRole: "mentor", kind: "note_logged" as const },
      { at: at(9), actorRef: MENTEE, actorRole: "mentee", kind: "note_logged" as const },
      { at: at(8), actorRef: MENTOR, actorRole: "mentor", kind: "session_scheduled" as const },
      { at: at(7), actorRef: MENTEE, actorRole: "mentee", kind: "session_scheduled" as const },
      { at: at(6), actorRef: MENTOR, actorRole: "mentor", kind: "message_sent" as const },
      { at: at(5), actorRef: MENTEE, actorRole: "mentee", kind: "message_sent" as const },
      { at: at(4), actorRef: MENTOR, actorRole: "mentor", kind: "message_sent" as const },
      { at: at(3), actorRef: MENTEE, actorRole: "mentee", kind: "message_sent" as const },
      { at: at(2), actorRef: MENTOR, actorRole: "mentor", kind: "note_logged" as const },
      { at: at(1), actorRef: MENTEE, actorRole: "mentee", kind: "note_logged" as const },
    ],
    surveys: [
      { at: at(28), rating: 0.9 },
      { at: at(14), rating: 0.85 },
      { at: at(7), rating: 0.95 },
      { at: at(1), rating: 0.9 },
    ],
    responseLatencies: [
      { at: at(10), hours: 2 },
      { at: at(8), hours: 4 },
      { at: at(6), hours: 3 },
      { at: at(4), hours: 2 },
      { at: at(2), hours: 5 },
    ],
    nextSessionAt: addDays(AS_OF, 7),
    ...over,
  });
}

/**
 * The mixed case the composite is really for: some components good, some bad,
 * every one of them observed. Exact expected values are asserted in
 * `health.test.ts`, which is why nothing here is randomised.
 */
export function mixedObservations(
  over: Partial<PairObservations> = {},
): PairObservations {
  return observations({
    // Three sessions across the trailing 42 days: fully on cadence.
    sessions: [
      { sessionId: "s_1", at: at(38), outcome: "held" as const },
      { sessionId: "s_2", at: at(24), outcome: "held" as const },
      { sessionId: "s_3", at: at(10), outcome: "held" as const },
    ],
    // 3 of 4 closed.
    actionItems: [
      { id: "a_1", createdAt: at(40), closedAt: at(35), dueAt: null },
      { id: "a_2", createdAt: at(30), closedAt: at(25), dueAt: null },
      { id: "a_3", createdAt: at(20), closedAt: at(15), dueAt: null },
      { id: "a_4", createdAt: at(10), closedAt: null, dueAt: at(-2) },
    ],
    // Halfway to the horizon, a quarter of the way through the goal.
    goals: [
      {
        goalId: "g_1",
        openedAt: at(50),
        targetAt: addDays(AS_OF, 50),
        checkIns: [
          { at: at(30), progress: 0.1 },
          { at: at(6), progress: 0.25 },
        ],
      },
    ],
    // Lopsided: the mentee logs some notes, the mentor schedules everything.
    activity: [
      { at: at(20), actorRef: MENTEE, actorRole: "mentee", kind: "note_logged" as const },
      { at: at(18), actorRef: MENTEE, actorRole: "mentee", kind: "note_logged" as const },
      { at: at(16), actorRef: MENTEE, actorRole: "mentee", kind: "note_logged" as const },
      { at: at(14), actorRef: MENTOR, actorRole: "mentor", kind: "note_logged" as const },
      { at: at(12), actorRef: MENTOR, actorRole: "mentor", kind: "session_scheduled" as const },
      { at: at(10), actorRef: MENTOR, actorRole: "mentor", kind: "session_scheduled" as const },
    ],
    surveys: [
      { at: at(24), rating: 0.8 },
      { at: at(10), rating: 0.6 },
    ],
    responseLatencies: [
      { at: at(20), hours: 12 },
      { at: at(15), hours: 24 },
      { at: at(5), hours: 36 },
    ],
    nextSessionAt: addDays(AS_OF, 4),
    ...over,
  });
}
