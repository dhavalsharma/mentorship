import type {
  GateResult,
  NudgeContext,
  NudgePlan,
  NudgeRecipient,
} from "./context.js";

/**
 * The gate chain. Nothing here is model-driven, and nothing here ever will be.
 *
 * The planner is allowed to be clever about *what* to say and to *whom*. What
 * it is not allowed to do is decide whether the user's attention is available,
 * because that decision is the difference between a useful assistant and a
 * muted channel, and once people mute you there is no recovering it — no
 * amount of later good judgment gets the channel back.
 *
 * So: every gate is a hard filter, evaluated in a fixed order, and a failure
 * is a drop with a logged reason. A drop is never silently retried. The sweep
 * will observe the same absence tomorrow and the chain will run again from
 * scratch — that is the retry, and it is visible.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface GateOutcome {
  results: GateResult[];
  /** The first failure in chain order — the one that gets reported. */
  blocked: GateResult | null;
  /** Earliest instant this could be tried again. Advisory, not a timer. */
  nextEligibleAt: string | null;
}

export interface GateInput {
  plan: NudgePlan;
  ctx: NudgeContext;
  /** Resolved by the caller, so the chain cannot run against a phantom. */
  recipient: NudgeRecipient;
}

export function applyGates(input: GateInput): GateOutcome {
  const { plan, ctx, recipient } = input;
  const nowMs = Date.parse(ctx.now);
  const results: GateResult[] = [];
  let nextEligibleAt: string | null = null;

  const pass = (gate: GateResult["gate"], reason?: string): void => {
    results.push({ gate, passed: true, reason: reason ?? null });
  };
  const fail = (gate: GateResult["gate"], reason: string): void => {
    results.push({ gate, passed: false, reason });
  };

  // 1. Mute and snooze. First, and absolute. "Honoured always, no exceptions"
  //    means it is not weighed against severity, seniority or how overdue the
  //    thing is — those are exactly the arguments that erode it.
  const snoozedUntilMs = recipient.snoozedUntil
    ? Date.parse(recipient.snoozedUntil)
    : null;
  if (recipient.muted) {
    fail("mute", `${recipient.participantId} has muted nudges`);
  } else if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) {
    fail("mute", `snoozed until ${recipient.snoozedUntil}`);
    nextEligibleAt = recipient.snoozedUntil;
  } else {
    pass("mute");
  }

  // 2. Dedupe. The sweep buckets an absence by week; this is the belt to that
  //    braces, because a replayed event or a second worker must not produce a
  //    second message.
  if (ctx.history.sentDedupeKeys.includes(ctx.dedupeKey)) {
    fail("dedupe", `already nudged for ${ctx.dedupeKey}`);
  } else {
    pass("dedupe");
  }

  // 3. Privacy. Invariant 13: a private message never falls back to the joint
  //    thread. A nudge naming one party as the blocker, landing in front of
  //    the other, is worse than no nudge at all — so when the private channel
  //    is unavailable the message is DROPPED, never rerouted.
  const addressesOnePerson = plan.recipientParticipantId !== null;
  if (addressesOnePerson && plan.channel !== "dm") {
    fail(
      "privacy",
      `plan addressed ${plan.recipientParticipantId} on the ${plan.channel}; a nudge naming one party is dm-only`,
    );
  } else if (addressesOnePerson && !recipient.channels.includes("dm")) {
    fail("privacy", "dm channel unavailable for this recipient; not falling back to the thread");
  } else {
    pass("privacy");
  }

  // 4. Already booked. Only for absences a session would actually fix: a
  //    meeting on Thursday does not close an overdue action item, and
  //    dropping that nudge would be a silent loss.
  if (ctx.deficit.name === "pair.cadence_deficit") {
    const bookedMs = ctx.pair.nextScheduledSessionAt
      ? Date.parse(ctx.pair.nextScheduledSessionAt)
      : null;
    if (bookedMs !== null && bookedMs > nowMs) {
      fail("already_booked", `session already booked for ${ctx.pair.nextScheduledSessionAt}`);
    } else {
      pass("already_booked");
    }
  } else {
    pass("already_booked", "not a scheduling deficit");
  }

  // 5. Rate limit. Per recipient, not per pair: a mentor with six mentees is
  //    one inbox, and counting per pair is how they get six messages.
  if (recipient.nudgesLast7Days >= ctx.limits.maxPerRecipientPerWeek) {
    fail(
      "rate_limit",
      `${recipient.nudgesLast7Days} nudges in the last 7 days, limit ${ctx.limits.maxPerRecipientPerWeek}`,
    );
    nextEligibleAt = nextEligibleAt ?? new Date(nowMs + 7 * DAY_MS).toISOString();
  } else {
    pass("rate_limit");
  }

  // 6. Quiet hours, in the RECIPIENT's timezone. Evaluating this in the
  //    server's zone is the classic version of this bug, and it reads as
  //    contempt to the person woken at 03:00.
  const quiet = recipient.quietHours ?? ctx.limits.quietHours;
  if (inQuietHours(nowMs, recipient.tzOffsetMinutes, quiet)) {
    fail(
      "quiet_hours",
      `local time is inside ${quiet.startHour}:00–${quiet.endHour}:00 for ${recipient.participantId}`,
    );
    nextEligibleAt =
      nextEligibleAt ?? quietHoursEndAt(nowMs, recipient.tzOffsetMinutes, quiet);
  } else {
    pass("quiet_hours");
  }

  return {
    results,
    blocked: results.find((r) => !r.passed) ?? null,
    nextEligibleAt,
  };
}

export function localHourAt(nowMs: number, tzOffsetMinutes: number): number {
  const local = nowMs + tzOffsetMinutes * 60_000;
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
}

export function inQuietHours(
  nowMs: number,
  tzOffsetMinutes: number,
  quiet: { startHour: number; endHour: number },
): boolean {
  if (quiet.startHour === quiet.endHour) return false; // an empty window
  const hour = localHourAt(nowMs, tzOffsetMinutes);
  return quiet.startHour < quiet.endHour
    ? hour >= quiet.startHour && hour < quiet.endHour
    : hour >= quiet.startHour || hour < quiet.endHour; // wraps midnight
}

/** The next instant the recipient's own local clock leaves the quiet window. */
export function quietHoursEndAt(
  nowMs: number,
  tzOffsetMinutes: number,
  quiet: { startHour: number; endHour: number },
): string {
  const offsetMs = tzOffsetMinutes * 60_000;
  const localMs = nowMs + offsetMs;
  const localDayStart = Math.floor(localMs / DAY_MS) * DAY_MS;
  let end = localDayStart + quiet.endHour * HOUR_MS;
  if (end <= localMs) end += DAY_MS;
  return new Date(end - offsetMs).toISOString();
}
