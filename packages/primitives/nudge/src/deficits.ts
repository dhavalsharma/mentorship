import { z } from "zod";
import { PairingStateSchema, type EventName, subjectRef } from "@mentorship/core";

/**
 * The temporal sweep: absence made into a fact.
 *
 * Every other event in this system is produced by something happening. Half of
 * what matters in a mentorship program is the opposite — no session in three
 * weeks, an action item quietly past due, a goal untouched since kickoff — and
 * **you cannot subscribe to nothing happening**. So a scheduled sweep compares
 * each pair's policy-declared expectation against its observed state and
 * manufactures the deficit events. From there the nudge engine is an ordinary
 * subscriber, with no special knowledge of time.
 *
 * This file is a pure function over a shape the caller assembles. It does not
 * import `@mentorship/db` and never will: the sweep is the part that must be
 * exhaustively testable at a hundred different values of `now`, and a query
 * planner in the middle of that is how you end up testing it once.
 */

/**
 * The four derived names from `EVENT_NAMES`. `satisfies` keeps this honest:
 * add a name here that the event taxonomy does not have and the build fails,
 * which is the point — event names are versioned and live in core.
 */
export const DEFICIT_EVENT_NAMES = [
  "pair.cadence_deficit",
  "action_item.overdue",
  "goal.stale",
  "survey.unanswered",
] as const satisfies readonly EventName[];

export const DeficitNameSchema = z.enum(DEFICIT_EVENT_NAMES);
export type DeficitName = z.infer<typeof DeficitNameSchema>;

export const DeficitSeveritySchema = z.enum(["low", "medium", "high"]);
export type DeficitSeverity = z.infer<typeof DeficitSeveritySchema>;

/**
 * Deficits carry only structured facts — dates, counts, ids. Deliberately no
 * participant-authored prose: a deficit ends up inside a model prompt, and
 * invariant 15 says notes are untrusted input. Names and titles are joined on
 * later, by the reader, for rendering only.
 */
export const DeficitSchema = z.object({
  name: DeficitNameSchema,
  orgId: z.string(),
  pairingId: z.string(),
  /** What the event is about: `pairing:p_001`, `action_item:ai_009`. */
  subjectRef: z.string(),
  occurredAt: z.string(),
  /**
   * Stable for as long as this absence is the same absence. A pair still
   * without a session next Tuesday produces the same key it did today, and a
   * different one next week — which is what stops a daily sweep from becoming
   * a daily nudge.
   */
  dedupeKey: z.string(),
  severity: DeficitSeveritySchema,
  /** How long the expectation has been unmet, in days. Fractional. */
  overdueDays: z.number(),
  /**
   * Who the absence deterministically belongs to, where it belongs to someone
   * — the action item's owner, the survey's recipient. Null when the sweep
   * genuinely does not know; guessing here is how the mentee gets chased for
   * the mentor's silence.
   */
  blockedOnParticipantId: z.string().nullable(),
  detail: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type Deficit = z.infer<typeof DeficitSchema>;

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export const SweepPairSchema = z.object({
  pairingId: z.string(),
  orgId: z.string(),
  state: PairingStateSchema,
  /** Resolved cadence for this pair. 0 = ad-hoc, and ad-hoc has no deficit. */
  cadenceEveryDays: z.number().int().min(0),
  /** The clock starts here when a pair has never met. */
  activatedAt: z.string(),
  lastSessionAt: z.string().nullable().default(null),
  /** A session already on the calendar. A pair mid-fix is not in deficit. */
  nextScheduledSessionAt: z.string().nullable().default(null),
  /** Set when the pair's own state knows who is silent (an open agreement). */
  blockedOnParticipantId: z.string().nullable().default(null),
});
export type SweepPair = z.infer<typeof SweepPairSchema>;

export const SweepActionItemSchema = z.object({
  actionItemId: z.string(),
  pairingId: z.string(),
  orgId: z.string(),
  ownerParticipantId: z.string(),
  dueAt: z.string(),
  status: z.enum(["open", "done", "dropped"]).default("open"),
});
export type SweepActionItem = z.infer<typeof SweepActionItemSchema>;

export const SweepGoalSchema = z.object({
  goalId: z.string(),
  pairingId: z.string(),
  orgId: z.string(),
  ownerParticipantId: z.string(),
  createdAt: z.string(),
  lastCheckInAt: z.string().nullable().default(null),
  status: z.enum(["open", "achieved", "abandoned"]).default("open"),
});
export type SweepGoal = z.infer<typeof SweepGoalSchema>;

export const SweepSurveySchema = z.object({
  surveyId: z.string(),
  pairingId: z.string(),
  orgId: z.string(),
  participantId: z.string(),
  sentAt: z.string(),
  answeredAt: z.string().nullable().default(null),
});
export type SweepSurvey = z.infer<typeof SweepSurveySchema>;

/**
 * Thresholds are sweep-level rather than per-tenant policy on purpose: they
 * are the *detector's* tolerances, not the program's expectations. The
 * program's expectation is `cadenceEveryDays`, which comes from
 * `ProgramPolicy.cadence` and is data. A caller running a tenant that wants a
 * week of grace passes a week.
 */
export const SweepThresholdsSchema = z.object({
  /** Days past due before a missed session is worth saying out loud. */
  cadenceGraceDays: z.number().min(0).default(2),
  actionItemGraceHours: z.number().min(0).default(0),
  goalStaleDays: z.number().positive().default(21),
  surveyUnansweredHours: z.number().positive().default(72),
});
export type SweepThresholds = z.infer<typeof SweepThresholdsSchema>;

export const SweepInputSchema = z.object({
  now: z.string(),
  pairs: z.array(SweepPairSchema).default([]),
  actionItems: z.array(SweepActionItemSchema).default([]),
  goals: z.array(SweepGoalSchema).default([]),
  surveys: z.array(SweepSurveySchema).default([]),
  /**
   * Dedupe keys the sweep has already emitted. Passing them makes the sweep
   * idempotent across runs without the sweep itself holding state — the same
   * trick the saga engine's effect ledger uses, for the same reason.
   */
  alreadyEmitted: z.array(z.string()).default([]),
  thresholds: SweepThresholdsSchema.default({}),
});
export type SweepInput = z.input<typeof SweepInputSchema>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * ISO-8601 week, in UTC: `2026-W38`. The bucket a recurring absence is keyed
 * to. A week is the right grain because it is also the grain people perceive
 * "you keep nagging me" at.
 */
export function isoWeek(at: string): string {
  const parsed = new Date(Date.parse(at));
  const target = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
  );
  // The ISO week belongs to the year containing its Thursday.
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** `pairing:p_001:cadence:2026-W38` — the key both this and the nudge use. */
export function deficitDedupeKey(input: {
  subjectRef: string;
  name: DeficitName;
  at: string;
}): string {
  const short = input.name.split(".").pop() ?? input.name;
  return `${input.subjectRef}:${short}:${isoWeek(input.at)}`;
}

function severityOf(overdueDays: number, cycleDays: number): DeficitSeverity {
  // Graded against the expectation itself, not an absolute number of days: a
  // week late on a weekly cadence is a missed cycle; on a quarterly one it is
  // a rounding error.
  const ratio = cycleDays > 0 ? overdueDays / cycleDays : overdueDays / 14;
  if (ratio >= 1) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}

const ORDER: Record<DeficitName, number> = {
  "pair.cadence_deficit": 0,
  "action_item.overdue": 1,
  "goal.stale": 2,
  "survey.unanswered": 3,
};

/**
 * Pure. Given every pair's expectation and observed state plus a `now`,
 * returns the deficit events that should be emitted, in a stable order.
 */
export function sweep(rawInput: SweepInput): Deficit[] {
  const input = SweepInputSchema.parse(rawInput);
  const nowMs = Date.parse(input.now);
  const seen = new Set(input.alreadyEmitted);
  const out: Deficit[] = [];

  const push = (deficit: Deficit): void => {
    if (seen.has(deficit.dedupeKey)) return;
    // Guards the case of two inputs colliding on one key inside a single
    // sweep, not just across sweeps.
    seen.add(deficit.dedupeKey);
    out.push(deficit);
  };

  const make = (
    name: DeficitName,
    fields: {
      orgId: string;
      pairingId: string;
      subjectRef: string;
      overdueDays: number;
      severity: DeficitSeverity;
      blockedOnParticipantId: string | null;
      detail: Deficit["detail"];
    },
  ): Deficit => ({
    name,
    orgId: fields.orgId,
    pairingId: fields.pairingId,
    subjectRef: fields.subjectRef,
    occurredAt: input.now,
    dedupeKey: deficitDedupeKey({
      subjectRef: fields.subjectRef,
      name,
      at: input.now,
    }),
    severity: fields.severity,
    overdueDays: Math.round(fields.overdueDays * 100) / 100,
    blockedOnParticipantId: fields.blockedOnParticipantId,
    detail: fields.detail,
  });

  // Only active pairs. A paused pair is paused on purpose, and chasing someone
  // on parental leave for a missed fortnightly is the single fastest way to
  // get a program switched off.
  const activePairs = new Map<string, SweepPair>();
  for (const pair of input.pairs) {
    if (pair.state !== "active") continue;
    activePairs.set(pair.pairingId, pair);
  }

  for (const pair of activePairs.values()) {
    if (pair.cadenceEveryDays <= 0) continue; // ad-hoc: no expectation to miss

    const anchor = pair.lastSessionAt ?? pair.activatedAt;
    const dueMs = Date.parse(anchor) + pair.cadenceEveryDays * DAY_MS;
    const graceMs = input.thresholds.cadenceGraceDays * DAY_MS;
    if (nowMs < dueMs + graceMs) continue;

    // A future session already booked means the absence is being fixed. The
    // gate chain checks this again at send time, because one can be booked
    // between the sweep and the send.
    const next = pair.nextScheduledSessionAt
      ? Date.parse(pair.nextScheduledSessionAt)
      : null;
    if (next !== null && next > nowMs) continue;

    const overdueDays = (nowMs - dueMs) / DAY_MS;
    push(
      make("pair.cadence_deficit", {
        orgId: pair.orgId,
        pairingId: pair.pairingId,
        subjectRef: subjectRef("pairing", pair.pairingId),
        overdueDays,
        severity: severityOf(overdueDays, pair.cadenceEveryDays),
        blockedOnParticipantId: pair.blockedOnParticipantId,
        detail: {
          expectedEveryDays: pair.cadenceEveryDays,
          lastSessionAt: pair.lastSessionAt,
          dueAt: new Date(dueMs).toISOString(),
          everMet: pair.lastSessionAt !== null,
        },
      }),
    );
  }

  for (const item of input.actionItems) {
    if (item.status !== "open") continue;
    if (!activePairs.has(item.pairingId)) continue;
    const dueMs = Date.parse(item.dueAt) + input.thresholds.actionItemGraceHours * HOUR_MS;
    if (nowMs <= dueMs) continue;

    const overdueDays = (nowMs - dueMs) / DAY_MS;
    push(
      make("action_item.overdue", {
        orgId: item.orgId,
        pairingId: item.pairingId,
        subjectRef: subjectRef("action_item", item.actionItemId),
        overdueDays,
        // An action item's cycle is its own due date, so grade against a week.
        severity: severityOf(overdueDays, 7),
        blockedOnParticipantId: item.ownerParticipantId,
        detail: { dueAt: item.dueAt, actionItemId: item.actionItemId },
      }),
    );
  }

  for (const goal of input.goals) {
    if (goal.status !== "open") continue;
    if (!activePairs.has(goal.pairingId)) continue;
    // Never checked in is not an exemption — it is the worst case. The clock
    // runs from creation.
    const lastTouch = Date.parse(goal.lastCheckInAt ?? goal.createdAt);
    const staleMs = input.thresholds.goalStaleDays * DAY_MS;
    if (nowMs < lastTouch + staleMs) continue;

    const overdueDays = (nowMs - lastTouch - staleMs) / DAY_MS;
    push(
      make("goal.stale", {
        orgId: goal.orgId,
        pairingId: goal.pairingId,
        subjectRef: subjectRef("goal", goal.goalId),
        overdueDays,
        severity: severityOf(overdueDays, input.thresholds.goalStaleDays),
        blockedOnParticipantId: goal.ownerParticipantId,
        detail: {
          goalId: goal.goalId,
          lastCheckInAt: goal.lastCheckInAt,
          daysSinceTouch:
            Math.round(((nowMs - lastTouch) / DAY_MS) * 100) / 100,
        },
      }),
    );
  }

  for (const survey of input.surveys) {
    if (survey.answeredAt !== null) continue;
    if (!activePairs.has(survey.pairingId)) continue;
    const dueMs =
      Date.parse(survey.sentAt) + input.thresholds.surveyUnansweredHours * HOUR_MS;
    if (nowMs < dueMs) continue;

    const overdueDays = (nowMs - dueMs) / DAY_MS;
    push(
      make("survey.unanswered", {
        orgId: survey.orgId,
        pairingId: survey.pairingId,
        subjectRef: subjectRef("survey", survey.surveyId),
        overdueDays,
        severity: severityOf(overdueDays, 7),
        blockedOnParticipantId: survey.participantId,
        detail: { surveyId: survey.surveyId, sentAt: survey.sentAt },
      }),
    );
  }

  return out.sort(
    (a, b) =>
      ORDER[a.name] - ORDER[b.name] || a.subjectRef.localeCompare(b.subjectRef),
  );
}

/**
 * The shape an event sink wants. Kept here rather than in `workflows` so the
 * sweep's output and the event it becomes cannot drift apart.
 */
export function toEventInput(deficit: Deficit): {
  name: EventName;
  orgId: string;
  subjectRef: string;
  occurredAt: string;
  payload: Record<string, unknown>;
} {
  return {
    name: deficit.name,
    orgId: deficit.orgId,
    subjectRef: deficit.subjectRef,
    occurredAt: deficit.occurredAt,
    payload: {
      pairingId: deficit.pairingId,
      dedupeKey: deficit.dedupeKey,
      severity: deficit.severity,
      overdueDays: deficit.overdueDays,
      blockedOnParticipantId: deficit.blockedOnParticipantId,
      ...deficit.detail,
    },
  };
}
