import { z } from "zod";
import { EvidenceSpanSchema } from "@mentorship/core";

/**
 * What one session produces, as data. This is the highest-value output in the
 * platform: it is the only thing generating confirmed, structured, labelled
 * records on every cycle — which is what the other three primitives need
 * before they can be any good.
 *
 * Two rules shape every field here:
 *
 *   - **Every inferred claim carries an evidence span** into the unedited
 *     source (invariant 18). A summary line is a reading of the whole; an
 *     action item, a goal movement or a blocker is a specific assertion about
 *     a specific person, and those must be checkable rather than believable.
 *   - **The model owns no number that affects a person** (invariant 17).
 *     Sentiment is a three-way band for the *session*, not a score for a
 *     participant; health and risk scores are composed deterministically from
 *     `signals` elsewhere.
 */

/**
 * Who owes the action. A participant ref from the pair, or `unassigned` — the
 * model may not invent a person, and `verifyExtraction` demotes any owner it
 * does not recognise rather than trusting a plausible-looking id.
 */
export const UNASSIGNED = "unassigned";

export const ActionItemSchema = z.object({
  /** A `participantId` from the pair, or `UNASSIGNED`. */
  owner: z.string().min(1),
  text: z.string().min(1).max(500),
  /**
   * Left as the phrase that was actually said ("by Friday", "before we next
   * meet"). Resolving that to an instant needs the pair's timezones and the
   * session date, which is deterministic work and does not belong to a model
   * (invariant 21 — wall-clock strings become wrong dates silently).
   */
  dueHint: z.string().max(120).nullable(),
  evidence: EvidenceSpanSchema,
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const GoalDirectionSchema = z.enum([
  "advanced",
  "blocked",
  "unchanged",
  "abandoned",
]);
export type GoalDirection = z.infer<typeof GoalDirectionSchema>;

export const GoalProgressSchema = z.object({
  /** A goal ref that was handed to the model in context, never a new one. */
  goalRef: z.string().min(1),
  direction: GoalDirectionSchema,
  note: z.string().max(500),
  evidence: EvidenceSpanSchema,
});
export type GoalProgress = z.infer<typeof GoalProgressSchema>;

export const BlockerSchema = z.object({
  text: z.string().min(1).max(500),
  evidence: EvidenceSpanSchema,
});
export type Blocker = z.infer<typeof BlockerSchema>;

/**
 * A band for the session, deliberately coarse and deliberately unattributed.
 * Invariant 14: activity is attributable, sentiment is not. Three buckets is
 * the most a reader can act on and the least that can be reverse-engineered
 * into "what did my mentee say about me".
 */
export const SentimentBandSchema = z.enum(["positive", "neutral", "strained"]);
export type SentimentBand = z.infer<typeof SentimentBandSchema>;

/**
 * `safeguarding` is not one flag among four. It bypasses every queue, batch
 * and nudge and reaches a named human out of band (invariant 16) — which is
 * why `gate` returns `escalate` for it and `approve` for everything else.
 */
export const RiskFlagSchema = z.enum([
  "relationship_mismatch",
  "out_of_scope",
  "needs_escalation",
  "safeguarding",
]);
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

const fields = {
  /** Three lines is a summary; ten is a second transcript nobody reads. */
  summary: z.array(z.string().min(1).max(400)).max(3),
  actionItems: z.array(ActionItemSchema).max(20),
  goalProgress: z.array(GoalProgressSchema).max(20),
  blockers: z.array(BlockerSchema).max(10),
  sentimentBand: SentimentBandSchema,
  riskFlags: z.array(RiskFlagSchema).max(4),
  nextSessionPrep: z.array(z.string().min(1).max(400)).max(3),
};

/**
 * The contract the rest of the system is written against: every field
 * present, so no consumer has to write `out.blockers ?? []` and none of them
 * disagree about what a missing field meant.
 */
export const SessionIntelOutputSchema = z.object(fields);
export type SessionIntelOutput = z.infer<typeof SessionIntelOutputSchema>;

/**
 * What the model is asked for — the same shape, with empty lists defaulted in.
 * A model that omits `blockers` because there were none is behaving sensibly,
 * and burning the one repair retry on that is how a good extraction ends up
 * degraded to cue-phrase matching. The strict schema above is applied after,
 * so nothing downstream sees the leniency.
 */
export const SessionIntelDraftSchema = z.object({
  summary: fields.summary.default([]),
  actionItems: fields.actionItems.default([]),
  goalProgress: fields.goalProgress.default([]),
  blockers: fields.blockers.default([]),
  sentimentBand: fields.sentimentBand.default("neutral"),
  riskFlags: fields.riskFlags.default([]),
  nextSessionPrep: fields.nextSessionPrep.default([]),
});

/** What a session with nothing in it produces. Not an error — an empty answer. */
export function emptyOutput(): SessionIntelOutput {
  return {
    summary: [],
    actionItems: [],
    goalProgress: [],
    blockers: [],
    sentimentBand: "neutral",
    riskFlags: [],
    nextSessionPrep: [],
  };
}
