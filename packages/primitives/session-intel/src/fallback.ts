import type { EvidenceSpan } from "@mentorship/core";
import type { SessionIntelContext } from "./context.js";
import {
  UNASSIGNED,
  emptyOutput,
  type ActionItem,
  type Blocker,
  type GoalProgress,
  type SentimentBand,
  type SessionIntelOutput,
} from "./schema.js";

/**
 * The deterministic answer: cue-phrase extraction, no model, no network.
 * Ported from `heuristicSessionIntel` in `packages/workflows/src/effects.ts`
 * and given real spans — the stub encoded the line number in a markdown
 * suffix, which reads like evidence but cannot be clicked, highlighted or
 * checked by anything.
 *
 * This runs whenever the model is unavailable, refuses, returns something the
 * schema rejects, or a participant has not consented to AI processing. A
 * platform whose session records stop existing because a vendor is down is
 * broken, not degraded — so this is deliberately dumb and always available.
 *
 * It emits **no risk flags, ever**, including `safeguarding`. Cue phrases
 * cannot tell a disclosure from someone quoting one, or from a note that
 * contains the word because a participant pasted it there (invariant 15), and
 * `safeguarding` wakes a named human out of band (invariant 16). A regex does
 * not get to make that call; silence here is the safe failure, because the
 * degraded extraction still lands in front of a human for confirmation.
 */

const COMMITMENT_CUES = [
  /\bI'?ll\b/i,
  /\bI will\b/i,
  /\bsend me\b/i,
  /\blet'?s make\b/i,
  /\bby (?:friday|monday|next week|then)\b/i,
  /\bwrite it up\b/i,
];

const BLOCKER_CUES = [
  /\bblocked\b/i,
  /\bstuck\b/i,
  /\bwaiting on\b/i,
  /\bheld up\b/i,
  /\bstruggling\b/i,
  /\bcan'?t get\b/i,
];

const STRAINED_CUES = [
  /\bfrustrat/i,
  /\bnot working\b/i,
  /\bmismatch\b/i,
  /\buncomfortable\b/i,
  /\bwaste of time\b/i,
  /\bawkward\b/i,
];

const POSITIVE_CUES = [
  /\bwent (?:really )?well\b/i,
  /\bgreat\b/i,
  /\breally helpful\b/i,
  /\bmade progress\b/i,
  /\bthank(?:s| you)\b/i,
];

const DUE_HINT =
  /\bby (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|then|end of (?:the )?week|month end)\b/i;

interface SourceLine {
  /** Speaker label before the colon, or null when the line has none. */
  speaker: string | null;
  /** What was said, trimmed, with the span that locates it in the source. */
  said: string;
  span: EvidenceSpan;
}

export function fallbackExtraction(ctx: SessionIntelContext): SessionIntelOutput {
  const lines = readLines(ctx.source);
  if (lines.length === 0) return emptyOutput();

  const actionItems: ActionItem[] = [];
  const blockers: Blocker[] = [];

  for (const line of lines) {
    if (COMMITMENT_CUES.some((cue) => cue.test(line.said))) {
      const due = DUE_HINT.exec(line.said);
      actionItems.push({
        owner: ownerFor(line.speaker, ctx),
        text: line.said.slice(0, 500),
        dueHint: due ? due[0] : null,
        evidence: line.span,
      });
    }
    if (BLOCKER_CUES.some((cue) => cue.test(line.said))) {
      blockers.push({ text: line.said.slice(0, 500), evidence: line.span });
    }
  }

  // Goals get a mention, never a direction. "advanced" from a keyword is a
  // fabricated number in prose form, and the pair's progress chart is not
  // something a cue phrase should move (invariant 17).
  const goalProgress: GoalProgress[] = [];
  for (const goal of ctx.goals) {
    const at = indexOfCaseInsensitive(ctx.source, goal.title);
    if (at === -1) continue;
    goalProgress.push({
      goalRef: goal.goalRef,
      direction: "unchanged",
      note: "Mentioned in the session. Direction not inferred without a model.",
      evidence: {
        start: at,
        end: at + goal.title.length,
        quote: ctx.source.slice(at, at + goal.title.length),
      },
    });
  }

  const summary = [
    `${lines.length} exchange${lines.length === 1 ? "" : "s"} captured from ${ctx.sourceRef}.`,
    actionItems.length > 0
      ? `${actionItems.length} commitment${actionItems.length === 1 ? "" : "s"} detected by cue phrase.`
      : "No explicit commitments detected.",
    "Extracted without a model — treat as a starting point, not a record.",
  ];

  const nextSessionPrep: string[] = [];
  for (const item of actionItems.slice(0, 2)) {
    nextSessionPrep.push(`Check whether this landed: ${truncate(item.text, 120)}`);
  }
  if (blockers.length > 0 && nextSessionPrep.length < 3) {
    nextSessionPrep.push(`Revisit blocker: ${truncate(blockers[0]!.text, 120)}`);
  }

  return {
    summary,
    actionItems,
    goalProgress,
    blockers,
    sentimentBand: sentimentOf(ctx.source),
    riskFlags: [],
    nextSessionPrep: nextSessionPrep.slice(0, 3),
  };
}

function sentimentOf(source: string): SentimentBand {
  const strained = STRAINED_CUES.filter((cue) => cue.test(source)).length;
  const positive = POSITIVE_CUES.filter((cue) => cue.test(source)).length;
  // Strain wins a tie: a session that is both warm and difficult is the one
  // worth a second look, and "neutral" is the honest answer to a draw.
  if (strained > 0 && strained >= positive) return "strained";
  if (positive > 0) return "positive";
  return "neutral";
}

/**
 * Splits on newlines while tracking the offset of each line in the *unedited*
 * source, so every span points at real characters. Trimming first and locating
 * afterwards is how spans drift by a couple of characters and stop matching.
 */
function readLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];
  let offset = 0;

  for (const raw of source.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1; // +1 for the newline that split consumed

    if (raw.trim().length === 0) continue;

    const colon = raw.indexOf(":");
    if (colon === -1) {
      const lead = raw.length - raw.trimStart().length;
      const said = raw.trim();
      out.push({
        speaker: null,
        said,
        span: { start: lineStart + lead, end: lineStart + lead + said.length, quote: said },
      });
      continue;
    }

    const speaker = raw.slice(0, colon).trim();
    const rest = raw.slice(colon + 1);
    const lead = rest.length - rest.trimStart().length;
    const said = rest.trim();
    if (said.length === 0) continue;

    const start = lineStart + colon + 1 + lead;
    out.push({
      speaker: speaker.length > 0 ? speaker : null,
      said,
      span: { start, end: start + said.length, quote: said },
    });
  }

  return out;
}

/**
 * A speaker label is whatever the transcript vendor wrote, so it is matched
 * against display names loosely — but only to a participant that exists. An
 * unrecognised label becomes `unassigned` rather than a guess: an action item
 * on the wrong person is worse than one on nobody, because nobody notices it
 * is wrong until the next session.
 */
function ownerFor(speaker: string | null, ctx: SessionIntelContext): string {
  if (!speaker) return UNASSIGNED;
  const needle = speaker.toLowerCase();

  const exact = ctx.participants.find(
    (p) => p.displayName.toLowerCase() === needle,
  );
  if (exact) return exact.participantId;

  const byFirstName = ctx.participants.filter((p) => {
    const first = p.displayName.split(/\s+/)[0]?.toLowerCase() ?? "";
    return first.length > 0 && (first === needle || needle.startsWith(`${first} `));
  });
  // Two people called Sam is exactly when a guess is worst.
  return byFirstName.length === 1 ? byFirstName[0]!.participantId : UNASSIGNED;
}

function indexOfCaseInsensitive(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
