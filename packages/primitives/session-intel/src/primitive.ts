import type { GateDecision, LlmProvider, Primitive } from "@mentorship/core";
import { structuredWithRepair } from "@mentorship/ai";
import {
  resolveSessionIntelContext,
  type SessionIntelContext,
  type SessionIntelReader,
  type SessionIntelTrigger,
} from "./context.js";
import { fallbackExtraction } from "./fallback.js";
import { buildExtractionPrompt, PROMPT_REF } from "./prompt.js";
import {
  SessionIntelDraftSchema,
  SessionIntelOutputSchema,
  UNASSIGNED,
  emptyOutput,
  type SessionIntelOutput,
} from "./schema.js";
import { verifyExtraction, type DroppedClaim } from "./evidence.js";

/**
 * The session-intelligence primitive: the first one worth building, because it
 * is the only one that *generates* labelled data. Every extraction lands
 * pending, a human confirms it in one tap (invariant 19), and that tap is both
 * the UX and the eval label the other three primitives will need.
 */

export const SESSION_INTEL_PRIMITIVE = "session.intel";

export interface SessionIntelPrimitiveOptions {
  /** Injectable fence nonce. Tests pin it; production must not. */
  nonce?: () => string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Dropped claims are a quality signal, not an error. Surfaced, not thrown. */
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

export type SessionIntelPrimitive = Primitive<
  SessionIntelTrigger,
  SessionIntelContext,
  SessionIntelOutput,
  SessionIntelReader
>;

export function createSessionIntelPrimitive(
  options: SessionIntelPrimitiveOptions = {},
): SessionIntelPrimitive {
  return {
    name: SESSION_INTEL_PRIMITIVE,
    promptVersion: PROMPT_REF,
    outputSchema: SessionIntelOutputSchema,

    resolve: resolveSessionIntelContext,

    async infer(ctx, llm: LlmProvider) {
      // A session with no transcript and no notes has nothing to extract.
      // Spending a model call to be told so costs money, adds latency and
      // invites the model to invent something to justify the call.
      if (ctx.source.trim().length === 0) return emptyOutput();

      const prompt = buildExtractionPrompt(ctx, options);

      const { value } = await structuredWithRepair(llm, {
        ...(prompt.system ? { system: prompt.system } : {}),
        prompt: prompt.prompt,
        schema: SessionIntelDraftSchema,
        schemaName: "SessionIntel",
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      });

      // Lenient on the wire, strict in the contract: the draft's defaults have
      // been applied by the provider, and this is where the shape the rest of
      // the system relies on is actually established.
      const draft = SessionIntelOutputSchema.parse(value);

      // The claim is only as good as the span. Verified against the unedited
      // source, never against the prompt — the prompt has a preamble in front
      // of the record and offsets into it would be silently shifted.
      const verified = verifyExtraction(ctx.source, draft, {
        knownOwners: [
          ...ctx.participants.map((p) => p.participantId),
          UNASSIGNED,
        ],
        knownGoals: ctx.goals.map((g) => g.goalRef),
      });

      if (verified.dropped.length > 0 || verified.relocated > 0) {
        options.onWarn?.("session intel evidence did not verify cleanly", {
          sessionId: ctx.sessionId,
          dropped: verified.dropped.length,
          relocated: verified.relocated,
          reasons: verified.dropped.map((d: DroppedClaim) => d.reason),
        });
      }

      return verified.output;
    },

    gate(out): GateDecision {
      // Invariant 16: safeguarding bypasses everything. Not a higher-priority
      // queue item — a different route entirely, out of band, to a named
      // human. It is checked before anything else here for the same reason.
      if (out.riskFlags.includes("safeguarding")) return "escalate";

      // Everything else, including the other risk flags, lands pending for a
      // human tap (invariant 19). There is deliberately no policy switch that
      // promotes an extraction to `auto`: a machine guess silently becoming an
      // agreed fact is the failure this whole design exists to prevent.
      return "approve";
    },

    fallback: fallbackExtraction,
  };
}
