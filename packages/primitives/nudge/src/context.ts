import { z } from "zod";
import { EvidenceSpanSchema } from "@mentorship/core";
import type { EventName } from "@mentorship/core";
import type { RankedTemplate, TemplateStat } from "./bandit.js";
import type { Deficit, DeficitName } from "./deficits.js";
import { NudgeChannelSchema, NudgeToneSchema } from "./templates.js";

/**
 * The read side of the nudge planner, and the shape of what it decides.
 *
 * The reader is an interface for the same reason `SagaResolvers` is: the
 * planner must be exhaustively testable with no database, and the Postgres
 * implementation belongs to whoever owns the query, not to the primitive.
 */

export interface NudgeRecipient {
  participantId: string;
  /** From `policy.roles`. Never enumerated here — roles are tenant data. */
  role: string;
  displayName: string;
  /** Verified DM/conversation member id, never an email guess. */
  memberRef: string;
  tzOffsetMinutes: number;
  /** Channels actually bound and usable for this person on this tenant. */
  channels: z.infer<typeof NudgeChannelSchema>[];
  /** Absolute. A muted person is never messaged, whatever the planner says. */
  muted: boolean;
  snoozedUntil: string | null;
  /** Local hours, wrapping midnight: 21 → 8 is the default night. */
  quietHours: { startHour: number; endHour: number };
  /** Delivered nudges in the trailing seven days. Feeds the rate limit. */
  nudgesLast7Days: number;
  /** Last time they answered anything — the least-bad blocker signal we have. */
  lastRespondedAt: string | null;
}

export interface NudgeAdmin {
  participantId: string;
  displayName: string;
  memberRef: string;
}

export interface NudgePairView {
  pairingId: string;
  orgId: string;
  title: string;
  /** "fortnightly" — from the resolved cadence, for the copy. */
  cadenceLabel: string;
  recipients: NudgeRecipient[];
  /** Re-read at plan time: one may have been booked since the sweep ran. */
  nextScheduledSessionAt: string | null;
  /** Where the top of the ladder points. Null means nobody is watching. */
  admin: NudgeAdmin | null;
}

export interface DeliveredNudge {
  sentAt: string;
  tone: z.infer<typeof NudgeToneSchema>;
  templateId: string;
  recipientParticipantId: string;
  /** Null while the seven-day attribution window is still open. */
  bookedWithin7Days: boolean | null;
}

export interface NudgeHistory {
  /** Deliveries about *this* absence. Drives the ladder, so drops don't count. */
  delivered: DeliveredNudge[];
  /** Gate drops since the last delivery. The third escalates. */
  consecutiveDrops: number;
  /** Dedupe keys already spent on this absence. */
  sentDedupeKeys: string[];
}

export interface NudgeReader {
  pair(pairingId: string): Promise<NudgePairView>;
  history(input: {
    pairingId: string;
    subjectRef: string;
    deficit: DeficitName;
  }): Promise<NudgeHistory>;
  /** Wins and losses per template for this deficit type, program-wide. */
  templateStats(input: {
    orgId: string;
    deficit: DeficitName;
  }): Promise<TemplateStat[]>;
  /**
   * A short human label for the goal / action item / survey. Participant-
   * authored, therefore untrusted: it is interpolated into copy for a human to
   * read and is never treated as instruction (invariant 15).
   */
  subjectLabel(subjectRef: string): Promise<string>;
}

export const NudgeLimitsSchema = z.object({
  /** Across all deficits, per person. Attention is the scarce resource. */
  maxPerRecipientPerWeek: z.number().int().min(0).default(3),
  /** Local hours. Wraps midnight. */
  quietHours: z
    .object({ startHour: z.number().min(0).max(23), endHour: z.number().min(0).max(23) })
    .default({ startHour: 21, endHour: 8 }),
  /** Deliveries about one absence before the ladder hands over to a human. */
  maxAttemptsPerAbsence: z.number().int().min(1).max(5).default(2),
  /** Consecutive gate drops before we tell someone instead of retrying. */
  dropsBeforeEscalation: z.number().int().min(1).max(10).default(3),
  /** Model copy longer than this is a red flag, not a feature. */
  maxBodyChars: z.number().int().min(80).default(600),
});
export type NudgeLimits = z.infer<typeof NudgeLimitsSchema>;

/** What `resolve` assembles. Deterministic, and the only input `infer` sees. */
export interface NudgeContext {
  now: string;
  deficit: Deficit;
  pair: NudgePairView;
  history: NudgeHistory;
  subjectLabel: string;
  dedupeKey: string;
  /**
   * The loudest rung this absence has earned. The model may choose quieter;
   * never louder. Invariant 11 lives here, not in the prompt.
   */
  tone: z.infer<typeof NudgeToneSchema>;
  /** Bandit order for that rung, computed once so `fallback` sees it too. */
  ranked: RankedTemplate[];
  /** The deterministic blocker guess, used when the model has no better idea. */
  defaultRecipientId: string | null;
  limits: NudgeLimits;
  /** The exact text handed to the model. Evidence spans point into this. */
  sourceText: string;
}

export const NudgePlanSchema = z.object({
  /** Null only for an escalation, which addresses the program admin. */
  recipientParticipantId: z.string().nullable(),
  recipientRole: z.string(),
  channel: NudgeChannelSchema,
  tone: NudgeToneSchema,
  templateId: z.string(),
  body: z.string().min(1),
  /** Why this party rather than the other one. The auditable half. */
  rationale: z.string(),
  /** Spans into `ctx.sourceText`, so a claim can be checked (invariant 18). */
  evidence: z.array(EvidenceSpanSchema),
});
export type NudgePlan = z.infer<typeof NudgePlanSchema>;

export const GATE_NAMES = [
  "mute",
  "dedupe",
  "privacy",
  "already_booked",
  "rate_limit",
  "quiet_hours",
] as const;
export const GateNameSchema = z.enum(GATE_NAMES);
export type GateName = z.infer<typeof GateNameSchema>;

export const GateResultSchema = z.object({
  gate: GateNameSchema,
  passed: z.boolean(),
  // Not defaulted: `ZodType<Out>` is invariant, so an input/output skew here
  // makes the whole decision schema unusable as `Primitive.outputSchema`.
  reason: z.string().nullable(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/**
 * The event this decision becomes. All four already exist in `EVENT_NAMES` —
 * `nudge.sent` is deliberately absent, because only the adapter that actually
 * delivered the message may claim that.
 */
export const DECISION_EVENT_NAMES = [
  "nudge.planned",
  "nudge.suppressed",
  "nudge.muted",
  "saga.escalated",
] as const satisfies readonly EventName[];

export const NudgeDecisionSchema = z.object({
  deficit: z.enum([
    "pair.cadence_deficit",
    "action_item.overdue",
    "goal.stale",
    "survey.unanswered",
  ]),
  pairingId: z.string(),
  subjectRef: z.string(),
  dedupeKey: z.string(),
  outcome: z.enum(["send", "drop", "escalate"]),
  plan: NudgePlanSchema,
  /** Every gate's verdict, not just the one that blocked. Drops are evidence. */
  gates: z.array(GateResultSchema),
  dropReason: z.string().nullable(),
  event: z.enum(DECISION_EVENT_NAMES),
  /**
   * When this absence could next be nudged about — information for the next
   * sweep, never a retry timer. A dropped nudge is dropped; the sweep decides
   * afresh tomorrow whether the absence still exists.
   */
  nextEligibleAt: z.string().nullable(),
});
export type NudgeDecision = z.infer<typeof NudgeDecisionSchema>;
