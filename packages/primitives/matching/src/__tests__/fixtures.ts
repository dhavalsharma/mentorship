import { z } from "zod";
import { defaultPolicy } from "@mentorship/core";
import type { Interval } from "@mentorship/core";
import {
  MenteeProfileSchema,
  MentorProfileSchema,
  defaultMatchingPolicy,
  type MatchingContext,
  type MenteeProfile,
  type MentorProfile,
} from "@mentorship/primitive-matching";

/**
 * Shared fixtures. Not a test file — vitest only collects `*.test.ts`.
 *
 * Every time here is a UTC instant (invariant 21). The fixtures deliberately
 * never build a "Tuesday 3pm" and then convert, because a test helper that
 * does wall-clock arithmetic is how wall-clock arithmetic gets into the
 * product.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const HORIZON: Interval = {
  start: "2026-10-05T00:00:00.000Z",
  end: "2026-10-19T00:00:00.000Z",
};
export const HORIZON_DAYS = 14;

/** `days` consecutive UTC windows of `lengthHours`, starting at `startHourUtc`. */
export function dailyWindows(
  startHourUtc: number,
  lengthHours: number,
  days = 10,
  from: string = HORIZON.start,
): Interval[] {
  const base = Date.parse(from);
  return Array.from({ length: days }, (_, d) => ({
    start: new Date(base + d * DAY + startHourUtc * HOUR).toISOString(),
    end: new Date(base + d * DAY + (startHourUtc + lengthHours) * HOUR).toISOString(),
  }));
}

/** Shift every interval by `minutes` — the "small perturbation" of the stability test. */
export function shift(intervals: Interval[], minutes: number): Interval[] {
  return intervals.map((i) => ({
    start: new Date(Date.parse(i.start) + minutes * 60_000).toISOString(),
    end: new Date(Date.parse(i.end) + minutes * 60_000).toISOString(),
  }));
}

type MentorInput = Partial<z.input<typeof MentorProfileSchema>> & { participantId: string };
type MenteeInput = Partial<z.input<typeof MenteeProfileSchema>> & { participantId: string };

export function makeMentor(over: MentorInput): MentorProfile {
  return MentorProfileSchema.parse({
    displayName: over.participantId,
    level: 6,
    capacity: 2,
    tzOffsetMinutes: 0,
    availability: dailyWindows(9, 4),
    strengths: [{ name: "system design", level: 5 }],
    ...over,
  });
}

export function makeMentee(over: MenteeInput): MenteeProfile {
  return MenteeProfileSchema.parse({
    displayName: over.participantId,
    level: 4,
    tzOffsetMinutes: 0,
    availability: dailyWindows(9, 4),
    goals: [{ name: "system design", currentLevel: 2, priority: 1 }],
    ...over,
  });
}

export function makeContext(input: {
  mentors: MentorProfile[];
  mentees: MenteeProfile[];
  matching?: Parameters<typeof defaultMatchingPolicy>[0];
}): MatchingContext {
  return {
    cohortId: "coh_1",
    orgId: "org_1",
    asOf: HORIZON.start,
    horizon: HORIZON,
    horizonDays: HORIZON_DAYS,
    mentors: input.mentors,
    mentees: input.mentees,
    policy: defaultMatchingPolicy(input.matching ?? {}),
  };
}

export const PROGRAM_POLICY = defaultPolicy({});

/** A tiny deterministic PRNG, so "random" instances are reproducible. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
