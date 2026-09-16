import { z } from "zod";
import { EvidenceSpanSchema, type LlmProvider } from "@mentorship/core";
import { structuredWithRepair, type PromptRegistry } from "@mentorship/ai";
import { MATCHING_ADJUDICATE_REF, MATCHING_PROMPTS } from "./prompts.js";
import { MatchRiskFlagSchema } from "./types.js";
import type { EvidenceSpan } from "@mentorship/core";
import type { MatchRiskFlag, MenteeProfile, MentorProfile } from "./types.js";
import type { MatchingPolicy } from "./policy.js";

/**
 * Stage 4, and the only stage a model touches. It runs on a shortlist — eight
 * candidates for one mentee, not four hundred pairs — because that is the only
 * scale at which a model call is both affordable and any good, and because the
 * ranking it is adjusting is already defensible without it.
 *
 * What comes back is a rationale, risk flags, and a *bounded* adjustment. The
 * model never produces the final score and never sees the capacity picture:
 * the solver owns the allocation (invariant 17).
 */

/**
 * Optional rather than defaulted: a `.default()` makes a zod schema's input
 * and output types diverge, which is a papercut everywhere these types are
 * passed around. Missing fields are coalesced at the single read site below —
 * the same leniency toward a model that omits `riskFlags`, without the
 * divergence.
 */
const AdjudicatedCandidateSchema = z.object({
  mentorId: z.string(),
  /** Clamped to policy on the way out; the schema is only the outer guard. */
  adjustment: z.number().min(-1).max(1).optional(),
  rationale: z.string().max(600).optional(),
  riskFlags: z.array(MatchRiskFlagSchema).max(5).optional(),
  evidence: z.array(EvidenceSpanSchema).max(4).optional(),
});

export const AdjudicationSchema = z.object({
  candidates: z.array(AdjudicatedCandidateSchema).max(25),
});
export type Adjudication = z.infer<typeof AdjudicationSchema>;

export interface CandidateAdjudication {
  adjustment: number;
  rationale: string | null;
  riskFlags: MatchRiskFlag[];
  evidence: EvidenceSpan[];
}

export interface ShortlistEntry {
  mentor: MentorProfile;
  deterministicScore: number;
  explanations: Record<string, string>;
}

export interface AdjudicateInput {
  mentee: MenteeProfile;
  shortlist: ShortlistEntry[];
  policy: MatchingPolicy;
  llm: LlmProvider;
  prompts?: PromptRegistry;
  promptRef?: string;
}

/** Participant prose is truncated and de-braced before it reaches a prompt. */
const NARRATIVE_LIMIT = 800;
function sanitiseNarrative(text: string): string {
  // Braces are stripped because the prompt registry's `{{var}}` substitution
  // runs over the template. It does not re-scan substituted values today, so
  // this is belt and braces — but a participant discovering they can write
  // `{{...}}` into a prompt is not a bug anyone wants to find in production.
  return text.replace(/[{}]/g, "").slice(0, NARRATIVE_LIMIT).trim();
}

/**
 * The exact string evidence spans index into. Built once and reused for
 * verification, because a span that points into a differently-rendered copy of
 * the profile is a span that cannot be checked — and an unverifiable citation
 * is worse than none (invariant 18).
 */
export function renderCandidatesBlock(shortlist: ShortlistEntry[]): string {
  return shortlist
    .map((entry, index) => {
      const { mentor } = entry;
      const strengths = mentor.strengths.length
        ? mentor.strengths.map((s) => `${s.name} (level ${s.level})`).join(", ")
        : "none stated";
      const features = Object.entries(entry.explanations)
        .map(([name, explain]) => `    - ${name}: ${explain}`)
        .join("\n");
      return [
        `${index + 1}. mentorId=${mentor.participantId} name=${mentor.displayName} level=${mentor.level}`,
        `    score=${entry.deterministicScore.toFixed(4)}`,
        `    strengths: ${strengths}`,
        features,
        `    <profile>${sanitiseNarrative(mentor.narrative)}</profile>`,
      ].join("\n");
    })
    .join("\n");
}

export function renderMenteeBlock(mentee: MenteeProfile): string {
  const goals = mentee.goals.length
    ? mentee.goals
        .map((g) => `${g.name} (at level ${g.currentLevel}, priority ${g.priority})`)
        .join(", ")
    : "none stated";
  return [
    `menteeId=${mentee.participantId} name=${mentee.displayName} level=${mentee.level}`,
    `goals: ${goals}`,
    `<profile>${sanitiseNarrative(mentee.narrative)}</profile>`,
  ].join("\n");
}

const clamp = (n: number, bound: number): number =>
  n > bound ? bound : n < -bound ? -bound : n;

/**
 * Spans are verified against the source rather than trusted. A model that
 * invents offsets produces a citation a reviewer clicks and finds points at
 * the wrong mentor, which is a worse failure than no citation at all.
 */
export function verifyEvidence(spans: EvidenceSpan[], source: string): EvidenceSpan[] {
  return spans.filter(
    (span) =>
      span.end > span.start &&
      span.end <= source.length &&
      source.slice(span.start, span.end) === span.quote,
  );
}

export async function adjudicateShortlist(
  input: AdjudicateInput,
): Promise<Map<string, CandidateAdjudication>> {
  const result = new Map<string, CandidateAdjudication>();
  if (input.shortlist.length === 0) return result;

  const registry = input.prompts ?? MATCHING_PROMPTS;
  const candidatesBlock = renderCandidatesBlock(input.shortlist);
  const rendered = registry.render(input.promptRef ?? MATCHING_ADJUDICATE_REF, {
    menteeBlock: renderMenteeBlock(input.mentee),
    candidatesBlock,
    bound: String(input.policy.maxAdjustment),
    flagList: MatchRiskFlagSchema.options.join(", "),
  });

  const { value } = await structuredWithRepair(input.llm, {
    ...(rendered.system ? { system: rendered.system } : {}),
    prompt: rendered.prompt,
    schema: AdjudicationSchema,
    schemaName: "MatchingAdjudication",
  });

  const known = new Set(input.shortlist.map((e) => e.mentor.participantId));
  for (const candidate of value.candidates) {
    // An id outside the shortlist is discarded rather than looked up: the
    // model's reach is the shortlist it was shown, and a hallucinated id must
    // not be able to introduce a candidate the constraints never cleared.
    if (!known.has(candidate.mentorId)) continue;
    result.set(candidate.mentorId, {
      adjustment: clamp(candidate.adjustment ?? 0, input.policy.maxAdjustment),
      rationale: candidate.rationale?.trim() || null,
      riskFlags: candidate.riskFlags ?? [],
      evidence: verifyEvidence(candidate.evidence ?? [], candidatesBlock),
    });
  }
  return result;
}
