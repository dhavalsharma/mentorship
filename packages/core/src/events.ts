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
  /**
   * The pair's conversation thread was resolved. Carried as an event rather
   * than a return value (invariant 5) so the channel id lands durably on the
   * pairing — which is the only way an inbound message from that channel can
   * be attributed back to a pair.
   */
  "pair.thread_bound",
  /**
   * A pair member chose a session length and/or rhythm off a structured
   * control. Written in the same transaction as the `pairings.cadence_override`
   * change it describes; a cooling `SessionLifecycle` waits on it to re-time
   * its next proposal rather than sleeping on the old cadence.
   */
  "pair.preferences_updated",
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
  "nudge.planned",
  "nudge.sent",
  "nudge.suppressed",
  "nudge.muted",
  // derived state
  "pair.health_updated",
  "pair.at_risk",
  "mentor.overloaded",
  "match.proposed",
  // safety — bypasses all automation
  "safeguarding.flagged",
  // operational
  "saga.escalated",
  /**
   * Written by the worker's periodic digest sweep (`apps/worker/src/digest.ts`).
   * There is no notification channel wired for a digest yet — this event is
   * the durable, queryable "sent" a future one can subscribe to, the same
   * honest half-measure `risk_findings` was before anything read it. The
   * payload carries the computed counts, not a rendered message: rendering
   * belongs to whatever channel eventually reads this.
   */
  "digest.computed",
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
  /**
   * The key of the saga effect that produced this event (`{effect key}:{name}`,
   * invariant 6), when an effect produced it; absent for anything a person or
   * an inbound route wrote. It is what lets the engine tell a step's own
   * emitted event from an outside one with the same name — see `advance()`
   * in `packages/workflows/src/engine.ts`.
   */
  idempotencyKey: z.string().optional(),
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
