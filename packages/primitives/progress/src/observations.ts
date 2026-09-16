import { z } from "zod";
import { CadenceSchema, ProgramPolicySchema } from "@mentorship/core";

/**
 * The observable facts a pair's health is computed from.
 *
 * These are *inputs to contributors*, not a storage format. Every number a
 * contributor emits lands in the `signals` table (subject_ref, kind, value,
 * confidence, source, observed_at) and nowhere else — ADR-0007 makes `signals`
 * the single unifying abstraction precisely so that health, risk and
 * dashboards cannot drift apart by reading different tables.
 *
 * Two shapes here are deliberately narrower than the data behind them:
 *
 *  - `SurveyResponseSchema` carries no participant reference. Invariant 14:
 *    individual feedback scores are never attributed to a named person outside
 *    the pair, and the cheapest way to keep a promise like that is to make the
 *    attributed form unrepresentable in the type that leaves the pair.
 *  - `MentorPairOutcomeSchema` carries an outcome and nothing else — no names,
 *    no scores. It exists for one risk rule and must not become a back door
 *    into another pair's detail.
 *
 * Every instant is a UTC ISO string (invariant 21). "Tuesday 3pm" produces
 * silently wrong overlaps and would make a cadence period land in the wrong
 * bucket twice a year.
 */

/** A session that actually happened, or conspicuously did not. */
export const SessionObservationSchema = z.object({
  sessionId: z.string(),
  /** Scheduled start, in UTC. Which cadence period it counts toward. */
  at: z.string(),
  outcome: z.enum(["held", "no_show", "cancelled"]).default("held"),
});
export type SessionObservation = z.infer<typeof SessionObservationSchema>;

export const ActionItemObservationSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** Null while open. Completion is a fact with a timestamp, never inferred. */
  closedAt: z.string().nullable().default(null),
  dueAt: z.string().nullable().default(null),
});
export type ActionItemObservation = z.infer<typeof ActionItemObservationSchema>;

export const GoalCheckInSchema = z.object({
  at: z.string(),
  /**
   * Self-reported progress, normalised to 0..1 at the edge. Velocity is about
   * the *delta* between check-ins against a horizon, not the absolute number,
   * so a mentee who starts an ambition at 0.4 is not permanently ahead.
   */
  progress: z.number().min(0).max(1),
});
export type GoalCheckIn = z.infer<typeof GoalCheckInSchema>;

export const GoalObservationSchema = z.object({
  goalId: z.string(),
  openedAt: z.string(),
  /** No horizon means no expected pace, so the goal contributes nothing. */
  targetAt: z.string().nullable().default(null),
  checkIns: z.array(GoalCheckInSchema).default([]),
});
export type GoalObservation = z.infer<typeof GoalObservationSchema>;

/**
 * Who did the work of keeping the relationship running. Activity is
 * attributable (invariant 14 draws the line at sentiment, not effort), but
 * `actorRef` is used only to count — it never reaches a prompt or an output.
 */
export const ActivityObservationSchema = z.object({
  at: z.string(),
  actorRef: z.string(),
  actorRole: z.string(),
  kind: z.enum(["note_logged", "session_scheduled", "message_sent"]),
});
export type ActivityObservation = z.infer<typeof ActivityObservationSchema>;

export const SurveyResponseSchema = z.object({
  at: z.string(),
  /** Normalised 0..1. A 1-5 star scale is converted once, at the edge. */
  rating: z.number().min(0).max(1),
});
export type SurveyResponse = z.infer<typeof SurveyResponseSchema>;

export const ResponseLatencyObservationSchema = z.object({
  at: z.string(),
  hours: z.number().min(0),
});
export type ResponseLatencyObservation = z.infer<
  typeof ResponseLatencyObservationSchema
>;

export const MentorPairOutcomeSchema = z.object({
  pairingId: z.string(),
  outcome: z.enum(["active", "completed", "ended_early", "paused"]),
  endedAt: z.string().nullable().default(null),
});
export type MentorPairOutcome = z.infer<typeof MentorPairOutcomeSchema>;

export const PairObservationsSchema = z.object({
  orgId: z.string(),
  pairingId: z.string(),
  /** Everything is computed relative to this instant, so a score replays. */
  asOf: z.string(),
  /** When the relationship became active — the denominator for data density. */
  startedAt: z.string(),
  /**
   * Policy and cadence travel with the observations for the same reason
   * `PairContext` carries them: `resolve()` takes no policy argument, and the
   * weights must not be constants in this package (ADR-0007).
   */
  policy: ProgramPolicySchema,
  cadence: CadenceSchema,
  /** Participant count, for the reciprocity balance denominator. */
  participantCount: z.number().int().min(1).default(2),
  sessions: z.array(SessionObservationSchema).default([]),
  actionItems: z.array(ActionItemObservationSchema).default([]),
  goals: z.array(GoalObservationSchema).default([]),
  activity: z.array(ActivityObservationSchema).default([]),
  surveys: z.array(SurveyResponseSchema).default([]),
  responseLatencies: z.array(ResponseLatencyObservationSchema).default([]),
  /** Null when nothing is on the calendar. One risk rule turns on exactly this. */
  nextSessionAt: z.string().nullable().default(null),
  /** The mentor's other pairs. Outcomes only — see the note at the top. */
  mentorPortfolio: z.array(MentorPairOutcomeSchema).default([]),
});
export type PairObservations = z.infer<typeof PairObservationsSchema>;

/** `subject_ref` is `text` so it can carry the kind. Matches the saga convention. */
export const pairSubjectRef = (pairingId: string): string =>
  `pairing:${pairingId}`;
