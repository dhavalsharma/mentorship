import { z } from "zod";
import type { Cadence, PairPreferencesPolicy } from "./policy.js";

/**
 * A pair choosing its own session length and rhythm.
 *
 * The choice arrives off a structured control — a select, or a number field
 * for "custom" — never out of prose (invariant 9): "shall we make it weekly?"
 * typed into the thread is a note, not a preference. This module is the one
 * place that turns what a control submitted into a validated cadence patch, so
 * the Slack modal and any future surface cannot drift apart on what counts as
 * a valid choice.
 */

export const CUSTOM_CHOICE = "custom";

export const PAIR_PREFERENCES_DISABLED_MESSAGE =
  "This program sets session length and rhythm for every pair.";

export const PairPreferencesSchema = z
  .object({
    sessionMinutes: z.number().int().min(15).max(240).optional(),
    everyDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((p) => p.sessionMinutes !== undefined || p.everyDays !== undefined, {
    message: "a preference update must change at least one of length or rhythm",
  });
export type PairPreferences = z.infer<typeof PairPreferencesSchema>;

/**
 * What a surface submitted: the selected option's value (a number as a
 * string, or `custom`) and the free number field beside it. Strings because
 * that is what every form control hands back.
 */
export interface PairPreferencesSubmission {
  sessionChoice: string | null;
  sessionCustom: string | null;
  cadenceChoice: string | null;
  cadenceCustom: string | null;
}

export type PreferenceField =
  | "sessionChoice"
  | "sessionCustom"
  | "cadenceChoice"
  | "cadenceCustom";

export type ResolvedPairPreferences =
  | { ok: true; preferences: PairPreferences }
  | { ok: false; field: PreferenceField; message: string };

/**
 * Validates against the program's own menu, not just the schema's bounds: a
 * forged submission naming 90 minutes when the program offers 15/30/45 and no
 * custom is refused, even though 90 is a perfectly good `sessionMinutes`.
 */
export function resolvePairPreferences(
  submission: PairPreferencesSubmission,
  policy: PairPreferencesPolicy,
): ResolvedPairPreferences {
  if (!policy.enabled) {
    return {
      ok: false,
      field: "sessionChoice",
      message: PAIR_PREFERENCES_DISABLED_MESSAGE,
    };
  }

  const session = pick(
    submission.sessionChoice,
    submission.sessionCustom,
    policy.sessionMinuteChoices,
    policy.allowCustomSessionMinutes,
    { min: 15, max: 240, unit: "minutes" },
  );
  if (!session.ok) {
    return {
      ok: false,
      field: session.onCustom ? "sessionCustom" : "sessionChoice",
      message: session.message,
    };
  }

  const cadence = pick(
    submission.cadenceChoice,
    submission.cadenceCustom,
    policy.cadenceDayChoices,
    policy.allowCustomCadenceDays,
    { min: 1, max: 365, unit: "days" },
  );
  if (!cadence.ok) {
    return {
      ok: false,
      field: cadence.onCustom ? "cadenceCustom" : "cadenceChoice",
      message: cadence.message,
    };
  }

  const preferences: PairPreferences = {};
  if (session.value !== undefined) preferences.sessionMinutes = session.value;
  if (cadence.value !== undefined) preferences.everyDays = cadence.value;
  if (preferences.sessionMinutes === undefined && preferences.everyDays === undefined) {
    return {
      ok: false,
      field: "sessionChoice",
      message: "Choose a session length, a rhythm, or both.",
    };
  }
  return { ok: true, preferences };
}

type Picked =
  | { ok: true; value: number | undefined }
  | { ok: false; onCustom: boolean; message: string };

function pick(
  choice: string | null,
  custom: string | null,
  allowed: number[],
  allowCustom: boolean,
  bounds: { min: number; max: number; unit: string },
): Picked {
  if (choice === null || choice === "") {
    // Nothing selected is "leave it as it is", but a number typed into the
    // custom box with no "custom" selected is ambiguous — say so rather than
    // quietly dropping what they typed.
    if (custom !== null && custom.trim() !== "") {
      return {
        ok: false,
        onCustom: false,
        message: `Select "Custom" to use your own number.`,
      };
    }
    return { ok: true, value: undefined };
  }

  if (choice === CUSTOM_CHOICE) {
    if (!allowCustom) {
      return { ok: false, onCustom: false, message: "Custom isn't offered here." };
    }
    const raw = custom?.trim() ?? "";
    if (!/^\d+$/.test(raw)) {
      return {
        ok: false,
        onCustom: true,
        message: `Enter a whole number of ${bounds.unit}.`,
      };
    }
    const n = Number(raw);
    if (n < bounds.min || n > bounds.max) {
      return {
        ok: false,
        onCustom: true,
        message: `Between ${bounds.min} and ${bounds.max} ${bounds.unit}.`,
      };
    }
    return { ok: true, value: n };
  }

  const n = Number(choice);
  if (!Number.isInteger(n) || !allowed.includes(n)) {
    return { ok: false, onCustom: false, message: "That isn't one of the options." };
  }
  return { ok: true, value: n };
}

/**
 * The words the saga and the nudge copy put around the cadence ("your
 * fortnightly session", "past your weekly catch-up"). The named rhythms use
 * the same labels `CADENCE_PRESETS` does; anything else reads "every N days",
 * matching what roster import already writes for a numeric cadence.
 */
export function cadenceLabelFor(everyDays: number): string {
  switch (everyDays) {
    case 7:
      return "weekly";
    case 14:
      return "fortnightly";
    case 21:
      return "three-weekly";
    case 28:
      return "four-weekly";
    default:
      return everyDays === 1 ? "daily" : `every ${everyDays} days`;
  }
}

/** "every 2 weeks" rather than "fortnightly" — for menus and confirmations. */
export function describeEveryDays(everyDays: number): string {
  if (everyDays === 7) return "every week";
  if (everyDays % 7 === 0) return `every ${everyDays / 7} weeks`;
  return everyDays === 1 ? "every day" : `every ${everyDays} days`;
}

/** "30-minute sessions, every 2 weeks" — both halves, whichever the pair set. */
export function describeCadence(cadence: Pick<Cadence, "sessionMinutes" | "everyDays">): string {
  const length = `${cadence.sessionMinutes}-minute sessions`;
  return cadence.everyDays > 0
    ? `${length}, ${describeEveryDays(cadence.everyDays)}`
    : `${length}, ad hoc`;
}

/**
 * Merges a pair's choice onto whatever override the pair already carries
 * (roster import may have set a cadence; the pair may later change only the
 * length). Only the keys the pair touched move. The label follows `everyDays`
 * so copy never says "fortnightly" about a weekly pair.
 */
export function applyPairPreferences(
  existing: Partial<Cadence> | null | undefined,
  preferences: PairPreferences,
): Partial<Cadence> {
  const next: Partial<Cadence> = { ...(existing ?? {}) };
  if (preferences.sessionMinutes !== undefined) {
    next.sessionMinutes = preferences.sessionMinutes;
  }
  if (preferences.everyDays !== undefined) {
    next.everyDays = preferences.everyDays;
    next.label = cadenceLabelFor(preferences.everyDays);
  }
  return next;
}
