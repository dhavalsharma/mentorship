import { z } from "zod";
import type { TemplateStat } from "./bandit.js";
import { DeficitNameSchema } from "./deficits.js";
import type { NudgeDecision } from "./context.js";
import { NudgeChannelSchema, NudgeToneSchema } from "./templates.js";

/**
 * The learning loop, and the reason the bandit has anything to learn from.
 *
 * Every delivered nudge is logged against one question: did a session get
 * booked within seven days. Not opened, not reacted to — booked. Engagement
 * metrics on a reminder measure whether the reminder was interesting, which
 * is not what it is for.
 *
 * Seven days is a judgement call: long enough that a nudge sent on a Friday
 * can be acted on the following week, short enough that the causal claim is
 * not absurd. It is a constant here because changing it retroactively
 * relabels history, which is worse than having picked the wrong number.
 */
export const ATTRIBUTION_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export const NudgeOutcomeSchema = z.object({
  nudgeId: z.string(),
  orgId: z.string(),
  pairingId: z.string(),
  subjectRef: z.string(),
  deficit: DeficitNameSchema,
  templateId: z.string(),
  tone: NudgeToneSchema,
  channel: NudgeChannelSchema,
  recipientParticipantId: z.string().nullable(),
  sentAt: z.string(),
  /** Null while the window is still open — an unresolved row, not a loss. */
  bookedWithin7Days: z.boolean().nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
});
export type NudgeOutcome = z.infer<typeof NudgeOutcomeSchema>;

/**
 * The row to write when a nudge is actually delivered. Written from the
 * decision rather than the adapter's response, so the template and tone that
 * produced it cannot be lost — an outcome without its arm is not a label.
 */
export function outcomeFromDecision(input: {
  decision: NudgeDecision;
  nudgeId: string;
  orgId: string;
  sentAt: string;
}): NudgeOutcome {
  return NudgeOutcomeSchema.parse({
    nudgeId: input.nudgeId,
    orgId: input.orgId,
    pairingId: input.decision.pairingId,
    subjectRef: input.decision.subjectRef,
    deficit: input.decision.deficit,
    templateId: input.decision.plan.templateId,
    tone: input.decision.plan.tone,
    channel: input.decision.plan.channel,
    recipientParticipantId: input.decision.plan.recipientParticipantId,
    sentAt: input.sentAt,
  });
}

/**
 * Resolve a row against the sessions booked for that pair. Idempotent: an
 * already-resolved row is returned untouched, because a later booking must not
 * turn a loss into a win six weeks after the fact.
 */
export function attributeOutcome(input: {
  outcome: NudgeOutcome;
  /** When each session was *booked*, not when it is scheduled to happen. */
  bookedAt: string[];
  now: string;
}): NudgeOutcome {
  const { outcome } = input;
  if (outcome.bookedWithin7Days !== null) return outcome;

  const sentMs = Date.parse(outcome.sentAt);
  const windowEndMs = sentMs + ATTRIBUTION_WINDOW_DAYS * DAY_MS;
  const hit = input.bookedAt
    .map((at) => Date.parse(at))
    .filter((ms) => ms >= sentMs && ms <= windowEndMs)
    .sort((a, b) => a - b)[0];

  if (hit !== undefined) {
    return { ...outcome, bookedWithin7Days: true, resolvedAt: new Date(hit).toISOString() };
  }
  if (Date.parse(input.now) >= windowEndMs) {
    return {
      ...outcome,
      bookedWithin7Days: false,
      resolvedAt: new Date(windowEndMs).toISOString(),
    };
  }
  return outcome; // window still open
}

/** 1, 0, or null while undecided. The bandit only counts the decided ones. */
export function rewardOf(outcome: NudgeOutcome): 0 | 1 | null {
  if (outcome.bookedWithin7Days === null) return null;
  return outcome.bookedWithin7Days ? 1 : 0;
}

/** Wins and losses per template, ready for `TemplateBandit.rank`. */
export function tallyTemplates(outcomes: NudgeOutcome[]): TemplateStat[] {
  const byId = new Map<string, TemplateStat>();
  for (const outcome of outcomes) {
    const reward = rewardOf(outcome);
    if (reward === null) continue;
    const stat = byId.get(outcome.templateId) ?? {
      templateId: outcome.templateId,
      wins: 0,
      losses: 0,
    };
    if (reward === 1) stat.wins += 1;
    else stat.losses += 1;
    byId.set(outcome.templateId, stat);
  }
  return [...byId.values()].sort((a, b) =>
    a.templateId.localeCompare(b.templateId),
  );
}
