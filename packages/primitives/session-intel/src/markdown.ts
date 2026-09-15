import type { PairContext } from "@mentorship/core";
import { UNASSIGNED, type SessionIntelOutput } from "./schema.js";

/**
 * The document projection (ADR-0005): the database is the source of truth and
 * this markdown is a rendering of it, regenerated rather than edited in place.
 *
 * Two things it deliberately does not render:
 *
 *   - **Risk flags are not written into the pair's shared document.** The pair
 *     reads this document. "relationship_mismatch" arriving in the notes both
 *     participants see is how a private admin signal becomes a conversation
 *     nobody was ready for, and `safeguarding` is routed out of band entirely
 *     (invariant 16) — it never appears in a shared surface.
 *   - **No per-person sentiment.** One band for the session, unattributed
 *     (invariant 14).
 */

export interface RenderOptions {
  sourceRef: string;
  /** True when the output came from the deterministic fallback. Said plainly. */
  degraded?: boolean;
}

export function renderExtractionMarkdown(
  out: SessionIntelOutput,
  pair: PairContext,
  options: RenderOptions,
): string {
  const nameOf = (ref: string): string => {
    if (ref === UNASSIGNED) return "Unassigned";
    const found = pair.participants.find((p) => p.participantId === ref);
    return found ? found.displayName : "Unassigned";
  };

  const lines: string[] = ["## Session summary", ""];

  if (out.summary.length > 0) {
    lines.push(...out.summary.map((s) => `- ${s}`));
  } else {
    lines.push(
      `_Nothing was captured for this session from \`${options.sourceRef}\`._`,
    );
  }

  lines.push("", "## Action items", "");
  if (out.actionItems.length > 0) {
    for (const item of out.actionItems) {
      const due = item.dueHint ? ` _(${item.dueHint})_` : "";
      // The quote is the point: the checkbox says what was committed, the
      // quote says where, so a participant can disagree with the record
      // rather than with the machine.
      lines.push(
        `- [ ] **${nameOf(item.owner)}**: ${item.text}${due}  \n  > ${item.evidence.quote}`,
      );
    }
  } else {
    lines.push("_None detected — confirm or add below._");
  }

  if (out.goalProgress.length > 0) {
    lines.push("", "## Goal progress", "");
    for (const goal of out.goalProgress) {
      lines.push(
        `- \`${goal.goalRef}\` — **${goal.direction}**: ${goal.note}  \n  > ${goal.evidence.quote}`,
      );
    }
  }

  if (out.blockers.length > 0) {
    lines.push("", "## Blockers", "");
    for (const blocker of out.blockers) {
      lines.push(`- ${blocker.text}  \n  > ${blocker.evidence.quote}`);
    }
  }

  if (out.nextSessionPrep.length > 0) {
    lines.push("", "## Before next time", "");
    lines.push(...out.nextSessionPrep.map((p) => `- ${p}`));
  }

  lines.push("", "## Pair", "");
  lines.push(
    ...pair.participants.map((p) => `- ${p.displayName} (${p.role})`),
  );

  lines.push("", `_Session tone: ${out.sentimentBand}._`);
  lines.push(
    options.degraded
      ? "_Extracted without a model (degraded) and not yet reviewed. Confirm in the thread._"
      : "_Extracted automatically and not yet reviewed. Confirm in the thread._",
  );

  return lines.join("\n");
}

/** The flat strings the saga's `extraction.completed` payload carries. */
export function actionItemLines(
  out: SessionIntelOutput,
  pair: PairContext,
): string[] {
  return out.actionItems.map((item) => {
    const owner = pair.participants.find(
      (p) => p.participantId === item.owner,
    );
    const label = owner ? owner.displayName : "Unassigned";
    const due = item.dueHint ? ` (${item.dueHint})` : "";
    return `${label}: ${item.text}${due}`;
  });
}
