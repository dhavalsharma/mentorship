import { hoursBetween, intersectIntervals } from "@mentorship/core";
import type { Interval } from "@mentorship/core";

/**
 * Availability maths, reusing core's interval algebra rather than a second
 * copy of it. The only thing this file adds is normalising to a fortnight,
 * which is what makes two cohorts with different horizons comparable.
 */

export function overlapHours(a: Interval[], b: Interval[]): number {
  return intersectIntervals(a, b).reduce(
    (sum, i) => sum + hoursBetween(i.start, i.end),
    0,
  );
}

/**
 * Overlap expressed per fortnight, whatever horizon the pool was built over.
 * Without this, widening the horizon from 14 to 28 days doubles every
 * availability score and silently re-ranks the whole cohort.
 */
export function overlapHoursPerFortnight(
  a: Interval[],
  b: Interval[],
  horizonDays: number,
): number {
  const hours = overlapHours(a, b);
  if (horizonDays <= 0) return hours;
  return hours * (14 / horizonDays);
}

export function horizonDaysOf(horizon: Interval): number {
  return hoursBetween(horizon.start, horizon.end) / 24;
}
