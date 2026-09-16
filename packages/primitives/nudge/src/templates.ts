import { z } from "zod";
import type { DeficitName } from "./deficits.js";

/**
 * The escalation ladder, and the copy at each rung.
 *
 * Three rungs, not five, because invariant 11 caps the whole thing at
 * "renudge once, then escalate" — a fourth tone would have nowhere to be used.
 * `admin` is the rung where we stop talking to the pair and talk to the person
 * running the program.
 */
export const NUDGE_TONES = ["gentle", "direct", "admin"] as const;
export const NudgeToneSchema = z.enum(NUDGE_TONES);
export type NudgeTone = z.infer<typeof NudgeToneSchema>;

export const NudgeChannelSchema = z.enum(["dm", "thread", "email"]);
export type NudgeChannel = z.infer<typeof NudgeChannelSchema>;

/** Rung index, for clamping. Higher is louder. */
export function toneRank(tone: NudgeTone): number {
  return NUDGE_TONES.indexOf(tone);
}

/**
 * The ladder is a function of how many times we have already spoken about
 * *this* absence, and it is deterministic. The model may choose a gentler
 * rung than the ladder allows; it may never choose a louder one.
 */
export function toneForAttempt(priorNudges: number): NudgeTone {
  if (priorNudges <= 0) return "gentle";
  if (priorNudges === 1) return "direct";
  return "admin";
}

export interface NudgeVars {
  recipientName: string;
  otherName: string;
  pairTitle: string;
  /** Whole days the expectation has been unmet. */
  overdueDays: number;
  cadenceLabel: string;
  /** Present for action items, goals and surveys; empty string otherwise. */
  subjectLabel: string;
}

export interface NudgeTemplate {
  id: string;
  deficit: DeficitName;
  tone: NudgeTone;
  render(vars: NudgeVars): string;
}

const days = (n: number): string => `${Math.max(1, Math.round(n))} day${Math.round(n) === 1 ? "" : "s"}`;

/**
 * Copy is code, not data, at this stage — a handful of hand-written variants
 * per rung is what the bandit needs to have something to choose between. When
 * there is a copy editor rather than an engineer changing these, they move to
 * the prompt registry and get versioned like prompts.
 */
const TEMPLATES: NudgeTemplate[] = [
  // --- cadence -------------------------------------------------------------
  {
    id: "cadence.gentle.streak",
    deficit: "pair.cadence_deficit",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — you and ${v.otherName} are ${days(v.overdueDays)} past your ${v.cadenceLabel} catch-up. Want me to find a time?`,
  },
  {
    id: "cadence.gentle.offer",
    deficit: "pair.cadence_deficit",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — no ${v.cadenceLabel} session with ${v.otherName} on the calendar yet. I can suggest three times if that helps.`,
  },
  {
    id: "cadence.gentle.short",
    deficit: "pair.cadence_deficit",
    tone: "gentle",
    render: (v) => `Hi ${v.recipientName} — time for a catch-up with ${v.otherName}?`,
  },
  {
    id: "cadence.direct.ask",
    deficit: "pair.cadence_deficit",
    tone: "direct",
    render: (v) =>
      `${v.recipientName}, ${v.otherName} is still waiting on a time — it has been ${days(v.overdueDays)}. Can you pick a slot today?`,
  },
  {
    id: "cadence.direct.binary",
    deficit: "pair.cadence_deficit",
    tone: "direct",
    render: (v) =>
      `${v.recipientName}: book a session with ${v.otherName} this week, or tell me the pairing should pause. Either is fine — silence is not.`,
  },
  {
    id: "cadence.admin.handoff",
    deficit: "pair.cadence_deficit",
    tone: "admin",
    render: (v) =>
      `${v.pairTitle} has had no session for ${days(v.overdueDays)} past their ${v.cadenceLabel} cadence, and two reminders went unanswered. Worth a human check-in.`,
  },

  // --- action items --------------------------------------------------------
  {
    id: "action.gentle.remind",
    deficit: "action_item.overdue",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — "${v.subjectLabel}" was due ${days(v.overdueDays)} ago. Still useful, or should it come off the list?`,
  },
  {
    id: "action.gentle.tidy",
    deficit: "action_item.overdue",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — one open item from your last session with ${v.otherName}: "${v.subjectLabel}".`,
  },
  {
    id: "action.direct.close",
    deficit: "action_item.overdue",
    tone: "direct",
    render: (v) =>
      `${v.recipientName}: "${v.subjectLabel}" is ${days(v.overdueDays)} overdue. Mark it done or drop it — a stale list stops being read.`,
  },
  {
    id: "action.admin.handoff",
    deficit: "action_item.overdue",
    tone: "admin",
    render: (v) =>
      `${v.pairTitle}: "${v.subjectLabel}" is ${days(v.overdueDays)} overdue after two reminders.`,
  },

  // --- goals ---------------------------------------------------------------
  {
    id: "goal.gentle.checkin",
    deficit: "goal.stale",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — "${v.subjectLabel}" has not moved in ${days(v.overdueDays)}. Worth five minutes with ${v.otherName}?`,
  },
  {
    id: "goal.gentle.reframe",
    deficit: "goal.stale",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — is "${v.subjectLabel}" still the right goal? Changing it is a good outcome too.`,
  },
  {
    id: "goal.direct.ask",
    deficit: "goal.stale",
    tone: "direct",
    render: (v) =>
      `${v.recipientName}: "${v.subjectLabel}" has been untouched for ${days(v.overdueDays)}. Update it or close it this week.`,
  },
  {
    id: "goal.admin.handoff",
    deficit: "goal.stale",
    tone: "admin",
    render: (v) =>
      `${v.pairTitle}: goal "${v.subjectLabel}" untouched for ${days(v.overdueDays)}, two reminders unanswered.`,
  },

  // --- surveys -------------------------------------------------------------
  {
    id: "survey.gentle.ask",
    deficit: "survey.unanswered",
    tone: "gentle",
    render: (v) =>
      `Hi ${v.recipientName} — two questions about how the mentoring is going, whenever you have a minute. Nobody in your pair sees your answers.`,
  },
  {
    id: "survey.gentle.short",
    deficit: "survey.unanswered",
    tone: "gentle",
    render: (v) => `Hi ${v.recipientName} — 30 seconds for a quick check-in survey?`,
  },
  {
    id: "survey.direct.ask",
    deficit: "survey.unanswered",
    tone: "direct",
    render: (v) =>
      `${v.recipientName}: the check-in survey has been open ${days(v.overdueDays)}. It closes soon, and your answers stay private.`,
  },
  {
    id: "survey.admin.handoff",
    deficit: "survey.unanswered",
    tone: "admin",
    render: (v) =>
      `${v.pairTitle}: a check-in survey has gone unanswered for ${days(v.overdueDays)} after two reminders.`,
  },
];

export const NUDGE_TEMPLATES: readonly NudgeTemplate[] = TEMPLATES;

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function templateById(id: string): NudgeTemplate | null {
  return BY_ID.get(id) ?? null;
}

/** The candidate set the bandit chooses from. Never empty for a known rung. */
export function templatesFor(
  deficit: DeficitName,
  tone: NudgeTone,
): NudgeTemplate[] {
  return TEMPLATES.filter((t) => t.deficit === deficit && t.tone === tone);
}
