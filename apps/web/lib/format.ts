/**
 * Pure display-mapping helpers, kept separate from the components that call
 * them so they can be unit tested without rendering React. `apps/web` has no
 * business logic of its own — this file is the closest thing to it.
 */

/** `toLocaleString()` on a nullish/unparsable value would throw or print
 * "Invalid Date"; this renders a clear placeholder instead. */
export function formatTimestamp(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export type SeverityTone = "critical" | "warning" | "neutral";

/**
 * `risk_findings.severity` is a free-text column (see `schema.ts`'s
 * comment), not a closed enum — this maps the values the seed/heuristics
 * actually produce and falls back to neutral for anything unrecognized,
 * rather than throwing on a value this app doesn't yet know about.
 */
export function severityTone(severity: string): SeverityTone {
  const normalized = severity.trim().toLowerCase();
  if (normalized === "high" || normalized === "critical") return "critical";
  if (normalized === "medium" || normalized === "moderate" || normalized === "low")
    return "warning";
  return "neutral";
}

export function requiresHumanLabel(requiresHuman: boolean): string {
  return requiresHuman ? "Needs a human" : "Automated";
}

/** `nudges.state` is likewise free text ('planned' | 'sent' | 'dropped' per
 * the schema comment, but not enforced by a DB constraint). */
export function nudgeStateTone(state: string): SeverityTone {
  const normalized = state.trim().toLowerCase();
  if (normalized === "dropped") return "critical";
  if (normalized === "planned") return "warning";
  return "neutral";
}

/**
 * "3 days", "1 day", or "less than a day" — how long ago `updatedAt` was,
 * for the stuck-sagas table. Deliberately coarse: an admin triaging a stuck
 * saga needs "has this been ignored for a week," not a precise duration.
 */
export function daysSince(value: string, now: () => Date = () => new Date()): string {
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return "—";
  const days = Math.floor((now().getTime() - then.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "less than a day";
  if (days === 1) return "1 day";
  return `${days} days`;
}

/**
 * "every 2 weeks", "every 10 days", "ad hoc" — a pair's rhythm in the same
 * words the Slack modal offers it (core's `describeEveryDays`; restated here
 * because this app reads JSON, never `@mentorship/core`).
 */
export function describeRhythm(everyDays: number): string {
  if (everyDays <= 0) return "ad hoc";
  if (everyDays === 1) return "every day";
  if (everyDays === 7) return "every week";
  if (everyDays % 7 === 0) return `every ${everyDays / 7} weeks`;
  return `every ${everyDays} days`;
}

/** "30 min, every 2 weeks". */
export function describeSessionCadence(cadence: {
  sessionMinutes: number;
  everyDays: number;
}): string {
  return `${cadence.sessionMinutes} min, ${describeRhythm(cadence.everyDays)}`;
}

/** Only the halves the participant touched: "length → 30 min". */
export function describeChanged(changed: {
  sessionMinutes?: number;
  everyDays?: number;
}): string {
  const parts: string[] = [];
  if (changed.sessionMinutes !== undefined) parts.push(`length → ${changed.sessionMinutes} min`);
  if (changed.everyDays !== undefined) parts.push(`rhythm → ${describeRhythm(changed.everyDays)}`);
  return parts.length > 0 ? parts.join("; ") : "—";
}
