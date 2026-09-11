import { z } from "zod";

/**
 * The event log is the spine. Two producers: facts written transactionally with
 * the state change, and derived events manufactured by the temporal sweep —
 * because you cannot subscribe to nothing happening.
 */

export const EVENT_NAMES = [
  // lifecycle (fact)
  "cohort.opened",
  "participant.enrolled",
  "pair.proposed",
  "pair.offered",
  "pair.activated",
  "pair.paused",
  "pair.ended",
  // activity (fact)
  "session.proposed",
  "session.scheduled",
  "session.cancelled",
  "session.reminded",
  "session.held",
  "session.no_show",
  "session.undocumented",
  "notes.submitted",
  "transcript.available",
  "extraction.completed",
  "document.rendered",
  // agreement (fact)
  "agreement.opened",
  "agreement.responded",
  "agreement.resolved",
  // deficit (derived — temporal sweep)
  "pair.cadence_deficit",
  "action_item.overdue",
  "goal.stale",
  "survey.unanswered",
  // human verdict (fact — and the best eval labels you will get)
  "extraction.confirmed",
  "extraction.edited",
  "feedback.submitted",
  "nudge.muted",
  // derived state
  "pair.health_updated",
  "pair.at_risk",
  // safety — bypasses all automation
  "safeguarding.flagged",
  // operational
  "saga.escalated",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const DomainEventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.enum(EVENT_NAMES),
  /** What this event is about: `pairing:p_001`, `session:s_004`. */
  subjectRef: z.string(),
  occurredAt: z.string(),
  version: z.number().int().default(1),
  payload: z.record(z.unknown()).default({}),
});

export type DomainEvent = z.infer<typeof DomainEventSchema>;

/**
 * A saga waits on a pattern rather than a concrete event, so `name` plus the
 * subject it already knows about is enough to route.
 */
export interface EventPattern {
  names: EventName[];
  subjectRef?: string;
}

export function matchesPattern(
  event: DomainEvent,
  pattern: EventPattern | null | undefined,
): boolean {
  if (!pattern) return false;
  if (!pattern.names.includes(event.name)) return false;
  if (pattern.subjectRef && pattern.subjectRef !== event.subjectRef) return false;
  return true;
}

export function subjectRef(kind: string, id: string): string {
  return `${kind}:${id}`;
}
