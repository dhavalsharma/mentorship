import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CADENCE_PRESETS,
  type Cadence,
  type PairingOrigin,
  type ProgramPolicy,
} from "@mentorship/core";
import { normaliseHeader, parseDelimited } from "./csv.js";

/**
 * Optional pairing.
 *
 * Matching is a capability, not a prerequisite. The most common real starting
 * point is an admin with a spreadsheet of pairs that already exist — decided in
 * a meeting, inherited from last year, or matched by hand. Those rows produce
 * exactly the same `pair.activated` event that the matching primitive would,
 * so everything downstream (the session saga, reminders, extraction, health
 * scoring) is identical and cannot tell the difference.
 *
 * The flow is always plan-then-commit. A roster import that writes on upload
 * is how an org ends up with 40 duplicate pairs and no way back.
 */

// ---------------------------------------------------------------------------
// Column aliases — admins will not rename their columns for us.
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string[]> = {
  mentorEmail: ["mentor_email", "mentor", "mentor_e_mail", "mentor_mail"],
  mentorName: ["mentor_name", "mentor_full_name", "mentor_display_name"],
  menteeEmail: [
    "mentee_email",
    "mentee",
    "mentee_e_mail",
    "mentee_mail",
    "participant_email",
  ],
  menteeName: ["mentee_name", "mentee_full_name", "mentee_display_name"],
  cadence: ["cadence", "frequency", "meeting_frequency", "rhythm"],
  startDate: ["start_date", "starts_on", "start", "kickoff"],
  mentorChatRef: ["mentor_slack", "mentor_slack_id", "mentor_chat_id"],
  menteeChatRef: ["mentee_slack", "mentee_slack_id", "mentee_chat_id"],
  mentorTz: ["mentor_tz", "mentor_timezone", "mentor_utc_offset"],
  menteeTz: ["mentee_tz", "mentee_timezone", "mentee_utc_offset"],
  notes: ["notes", "comment", "comments", "context"],
};

function buildHeaderMap(headerRow: string[]): {
  map: Record<string, number>;
  unknown: string[];
} {
  const map: Record<string, number> = {};
  const unknown: string[] = [];
  headerRow.forEach((raw, index) => {
    const norm = normaliseHeader(raw);
    if (!norm) return;
    const canonical = Object.entries(ALIASES).find(([, alts]) =>
      alts.includes(norm),
    )?.[0];
    if (canonical) {
      if (!(canonical in map)) map[canonical] = index;
    } else {
      unknown.push(raw.trim());
    }
  });
  return { map, unknown };
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

const EMAIL = z
  .string()
  .trim()
  .min(3)
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "not an email address")
  .transform((v) => v.toLowerCase());

export const RosterRowSchema = z.object({
  mentorEmail: EMAIL,
  mentorName: z.string().trim().min(1).optional(),
  menteeEmail: EMAIL,
  menteeName: z.string().trim().min(1).optional(),
  cadence: z.string().trim().optional(),
  startDate: z.string().trim().optional(),
  mentorChatRef: z.string().trim().optional(),
  menteeChatRef: z.string().trim().optional(),
  mentorTz: z.string().trim().optional(),
  menteeTz: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});
export type RosterRow = z.infer<typeof RosterRowSchema>;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlannedPerson {
  email: string;
  displayName: string;
  role: "mentor" | "mentee";
  chatRef: string | null;
  tzOffsetMinutes: number;
}

export interface PlannedPair {
  rowNumber: number;
  pairKey: string;
  mentor: PlannedPerson;
  mentee: PlannedPerson;
  origin: PairingOrigin;
  cadenceOverride: Partial<Cadence> | null;
  startsAt: string | null;
  notes: string | null;
}

export interface ImportIssue {
  rowNumber: number;
  field?: string;
  message: string;
}

export interface ImportPlan {
  fileHash: string;
  creates: PlannedPair[];
  /** Already present, or a duplicate inside the same file. */
  skipped: ImportIssue[];
  /** Row cannot be imported. Nothing in the file commits until these are zero or waived. */
  errors: ImportIssue[];
  /** Importable, but the admin should look. */
  warnings: ImportIssue[];
  newPeople: PlannedPerson[];
  unknownColumns: string[];
  summary: {
    rowsRead: number;
    pairsToCreate: number;
    peopleToCreate: number;
    skipped: number;
    errors: number;
    warnings: number;
  };
}

export interface ExistingState {
  /** Lowercased email -> known participant. */
  participantsByEmail: Map<string, { participantId: string; role: string }>;
  /** Canonical pair keys already in this cohort. */
  pairKeys: Set<string>;
  /** Mentor email -> how many active mentees they already carry. */
  mentorLoad: Map<string, number>;
}

export const emptyExistingState = (): ExistingState => ({
  participantsByEmail: new Map(),
  pairKeys: new Set(),
  mentorLoad: new Map(),
});

/** Order-independent, so a re-upload with the columns swapped still dedupes. */
export function pairKey(a: string, b: string): string {
  return [a.toLowerCase().trim(), b.toLowerCase().trim()].sort().join("|");
}

export function parseTzOffset(
  raw: string | undefined,
  fallback: number,
): { minutes: number; ok: boolean } {
  if (!raw) return { minutes: fallback, ok: true };
  const value = raw.trim();
  const hhmm = /^([+-])(\d{1,2}):?(\d{2})$/.exec(value);
  if (hhmm) {
    const sign = hhmm[1] === "-" ? -1 : 1;
    return {
      minutes: sign * (Number(hhmm[2]) * 60 + Number(hhmm[3])),
      ok: true,
    };
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    // A bare number is read as hours if it is small, minutes otherwise.
    return {
      minutes: Math.abs(asNumber) <= 14 ? asNumber * 60 : asNumber,
      ok: true,
    };
  }
  return { minutes: fallback, ok: false };
}

export function parseCadence(
  raw: string | undefined,
): { cadence: Partial<Cadence> | null; ok: boolean } {
  if (!raw) return { cadence: null, ok: true };
  const value = raw.trim().toLowerCase();
  const aliases: Record<string, string> = {
    biweekly: "fortnightly",
    "every 2 weeks": "fortnightly",
    "2 weeks": "fortnightly",
    "every week": "weekly",
    "every month": "monthly",
    "ad hoc": "adhoc",
    "as needed": "adhoc",
  };
  const key = aliases[value] ?? value;
  const preset = CADENCE_PRESETS[key];
  if (preset) return { cadence: preset, ok: true };

  const days = /^(\d{1,3})\s*d(ays?)?$/.exec(value) ?? /^(\d{1,3})$/.exec(value);
  if (days) {
    const n = Number(days[1]);
    if (n >= 0 && n <= 365) {
      return { cadence: { everyDays: n, label: `every ${n} days` }, ok: true };
    }
  }
  return { cadence: null, ok: false };
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export interface PlanOptions {
  policy: ProgramPolicy;
  existing?: ExistingState;
  defaultTzOffsetMinutes?: number;
}

export function planRosterImport(
  fileContents: string,
  opts: PlanOptions,
): ImportPlan {
  const fileHash = createHash("sha256").update(fileContents).digest("hex");
  const rows = parseDelimited(fileContents);
  const existing = opts.existing ?? emptyExistingState();
  const defaultTz = opts.defaultTzOffsetMinutes ?? 0;

  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const skipped: ImportIssue[] = [];
  const creates: PlannedPair[] = [];
  const newPeople = new Map<string, PlannedPerson>();

  const headerRow = rows[0];
  if (!headerRow) {
    return emptyPlan(fileHash, [
      { rowNumber: 0, message: "the file is empty" },
    ]);
  }

  const { map, unknown } = buildHeaderMap(headerRow);
  for (const required of ["mentorEmail", "menteeEmail"] as const) {
    if (!(required in map)) {
      return emptyPlan(fileHash, [
        {
          rowNumber: 1,
          field: required,
          message: `no column found for ${required}. Accepted headers: ${ALIASES[
            required
          ]!.join(", ")}`,
        },
      ]);
    }
  }

  const seenInFile = new Map<string, number>();
  // Load is tracked as we plan, so the 3rd mentee for a 2-capacity mentor is
  // flagged even when all three are new rows in the same upload.
  const load = new Map(existing.mentorLoad);

  const dataRows = rows.slice(1);
  for (const [i, raw] of dataRows.entries()) {
    const rowNumber = i + 2; // 1-based, plus the header
    const cell = (key: string): string | undefined => {
      const index = map[key];
      if (index === undefined) return undefined;
      const value = raw[index];
      return value === undefined || value.trim() === "" ? undefined : value;
    };

    const parsed = RosterRowSchema.safeParse({
      mentorEmail: cell("mentorEmail"),
      mentorName: cell("mentorName"),
      menteeEmail: cell("menteeEmail"),
      menteeName: cell("menteeName"),
      cadence: cell("cadence"),
      startDate: cell("startDate"),
      mentorChatRef: cell("mentorChatRef"),
      menteeChatRef: cell("menteeChatRef"),
      mentorTz: cell("mentorTz"),
      menteeTz: cell("menteeTz"),
      notes: cell("notes"),
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          rowNumber,
          field: String(issue.path[0] ?? ""),
          message: issue.message,
        });
      }
      continue;
    }
    const row = parsed.data;

    if (row.mentorEmail === row.menteeEmail) {
      errors.push({
        rowNumber,
        message: "mentor and mentee are the same person",
      });
      continue;
    }

    const key = pairKey(row.mentorEmail, row.menteeEmail);

    const firstSeen = seenInFile.get(key);
    if (firstSeen !== undefined) {
      skipped.push({
        rowNumber,
        message: `duplicate of row ${firstSeen} in this file`,
      });
      continue;
    }
    seenInFile.set(key, rowNumber);

    if (existing.pairKeys.has(key)) {
      // Re-uploading last week's sheet with three new rows at the bottom is
      // the normal case, not an error.
      skipped.push({ rowNumber, message: "pair already exists in this cohort" });
      continue;
    }

    const cadenceResult = parseCadence(row.cadence);
    if (!cadenceResult.ok) {
      errors.push({
        rowNumber,
        field: "cadence",
        message: `unrecognised cadence "${row.cadence}". Try: weekly, fortnightly, monthly, quarterly, adhoc, or a number of days`,
      });
      continue;
    }

    let startsAt: string | null = null;
    if (row.startDate) {
      const parsedDate = new Date(row.startDate);
      if (Number.isNaN(parsedDate.getTime())) {
        errors.push({
          rowNumber,
          field: "startDate",
          message: `could not read the date "${row.startDate}"`,
        });
        continue;
      }
      startsAt = parsedDate.toISOString();
    }

    const mentorTz = parseTzOffset(row.mentorTz, defaultTz);
    const menteeTz = parseTzOffset(row.menteeTz, defaultTz);
    for (const [label, result] of [
      ["mentorTz", mentorTz],
      ["menteeTz", menteeTz],
    ] as const) {
      if (!result.ok) {
        warnings.push({
          rowNumber,
          field: label,
          message: `could not read the timezone offset; using the org default (${defaultTz} min)`,
        });
      }
    }
    if (!row.mentorTz && !row.menteeTz) {
      warnings.push({
        rowNumber,
        message:
          "no timezone for either party; proposed times will assume the org default",
      });
    }

    // Identity mapping: without a verified chat id we cannot open a private
    // pair thread, and guessing from email is how the wrong person ends up in
    // someone's mentoring conversation.
    if (!row.mentorChatRef || !row.menteeChatRef) {
      warnings.push({
        rowNumber,
        message:
          "missing a verified chat id for at least one party; they will be asked to confirm their account before the first proposal",
      });
    }

    const mentor: PlannedPerson = {
      email: row.mentorEmail,
      displayName: row.mentorName ?? nameFromEmail(row.mentorEmail),
      role: "mentor",
      chatRef: row.mentorChatRef ?? null,
      tzOffsetMinutes: mentorTz.minutes,
    };
    const mentee: PlannedPerson = {
      email: row.menteeEmail,
      displayName: row.menteeName ?? nameFromEmail(row.menteeEmail),
      role: "mentee",
      chatRef: row.menteeChatRef ?? null,
      tzOffsetMinutes: menteeTz.minutes,
    };

    const nextLoad = (load.get(row.mentorEmail) ?? 0) + 1;
    load.set(row.mentorEmail, nextLoad);
    if (nextLoad > opts.policy.pairing.mentorCapacityDefault) {
      warnings.push({
        rowNumber,
        message: `${mentor.displayName} now has ${nextLoad} mentees, above the program default of ${opts.policy.pairing.mentorCapacityDefault}`,
      });
    }

    for (const person of [mentor, mentee]) {
      if (
        !existing.participantsByEmail.has(person.email) &&
        !newPeople.has(person.email)
      ) {
        newPeople.set(person.email, person);
      }
    }

    creates.push({
      rowNumber,
      pairKey: key,
      mentor,
      mentee,
      origin: "imported",
      cadenceOverride: cadenceResult.cadence,
      startsAt,
      notes: row.notes ?? null,
    });
  }

  return {
    fileHash,
    creates,
    skipped,
    errors,
    warnings,
    newPeople: [...newPeople.values()],
    unknownColumns: unknown,
    summary: {
      rowsRead: dataRows.length,
      pairsToCreate: creates.length,
      peopleToCreate: newPeople.size,
      skipped: skipped.length,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}

function emptyPlan(fileHash: string, errors: ImportIssue[]): ImportPlan {
  return {
    fileHash,
    creates: [],
    skipped: [],
    errors,
    warnings: [],
    newPeople: [],
    unknownColumns: [],
    summary: {
      rowsRead: 0,
      pairsToCreate: 0,
      peopleToCreate: 0,
      skipped: 0,
      errors: errors.length,
      warnings: 0,
    },
  };
}

/** Errors block the commit unless the admin explicitly waives the bad rows. */
export function planIsCommittable(
  plan: ImportPlan,
  opts: { allowPartial?: boolean } = {},
): boolean {
  if (plan.creates.length === 0) return false;
  return opts.allowPartial === true || plan.errors.length === 0;
}

export function renderPlan(plan: ImportPlan): string {
  const lines: string[] = [];
  lines.push(
    `Read ${plan.summary.rowsRead} rows — ${plan.summary.pairsToCreate} pairs to create, ${plan.summary.peopleToCreate} people to add.`,
  );
  if (plan.unknownColumns.length > 0) {
    lines.push(`Ignored columns: ${plan.unknownColumns.join(", ")}`);
  }
  for (const e of plan.errors) {
    lines.push(
      `  ERROR   row ${e.rowNumber}${e.field ? ` [${e.field}]` : ""}: ${e.message}`,
    );
  }
  for (const s of plan.skipped) {
    lines.push(`  SKIP    row ${s.rowNumber}: ${s.message}`);
  }
  for (const w of plan.warnings) {
    lines.push(`  WARN    row ${w.rowNumber}: ${w.message}`);
  }
  for (const c of plan.creates) {
    const cadence = c.cadenceOverride?.label ?? "program default";
    lines.push(
      `  CREATE  ${c.mentor.displayName} -> ${c.mentee.displayName}  (${cadence})`,
    );
  }
  return lines.join("\n");
}
