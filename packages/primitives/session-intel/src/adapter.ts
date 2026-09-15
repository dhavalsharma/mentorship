import type {
  GateDecision,
  IdFactory,
  LlmProvider,
  PairContext,
} from "@mentorship/core";
import { uuidIds } from "@mentorship/core";
import { runPrimitive, type AiRunSink } from "@mentorship/ai";
import type { GoalRef, SessionSourceKind } from "./context.js";
import { actionItemLines, renderExtractionMarkdown } from "./markdown.js";
import {
  createSessionIntelPrimitive,
  type SessionIntelPrimitiveOptions,
} from "./primitive.js";
import type { SessionIntelOutput } from "./schema.js";

/**
 * The drop-in replacement for `heuristicSessionIntel`.
 *
 * The shape is dictated by `SessionIntel` in `packages/workflows/src/effects.ts`
 * — declared here rather than imported, because the dependency direction is
 * one-way and a primitive importing `workflows` inverts it (and would make the
 * two packages circular). It is structurally identical, so
 * `createEffectRunner({ intel: createPrimitiveSessionIntel({ llm }) })`
 * type-checks with nothing else moving. The honest home for this interface is
 * `packages/core`; putting it there is a one-line change in core that this
 * package is not allowed to make.
 *
 * The extra fields on the result (`output`, `gate`, `degraded`) are additive:
 * the effect runner reads the three it knows about and ignores the rest, while
 * anything that wants the structured record — the confirm step, the eval
 * harness, the risk router — can have it without re-parsing markdown.
 */

export interface SessionIntelExtractInput {
  sessionId: string;
  sourceRef: string;
  text: string;
  pair: PairContext;
}

export interface SessionIntelExtractResult {
  extractionId: string;
  markdown: string;
  actionItems: string[];
  /** The structured record. Markdown is a projection of this, never the truth. */
  output: SessionIntelOutput;
  gate: GateDecision;
  degraded: boolean;
  /**
   * Always `pending` (invariant 19). A field rather than a constant in the
   * caller so that a future auto-confirm-on-timeout path has somewhere to
   * record `unverified` instead of quietly promoting a guess.
   */
  status: "pending";
}

export interface SessionIntelPort {
  extract(input: SessionIntelExtractInput): Promise<SessionIntelExtractResult>;
}

export interface PrimitiveSessionIntelOptions
  extends SessionIntelPrimitiveOptions {
  llm: LlmProvider;
  ids?: IdFactory;
  runs?: AiRunSink;
  /** Goals for the pair. Absent means "no goals in scope", never "invent some". */
  goals?: (pairingId: string) => Promise<GoalRef[]>;
  /** Override the sourceRef-based guess when the caller knows better. */
  classifySource?: (sourceRef: string) => SessionSourceKind;
}

export function createPrimitiveSessionIntel(
  options: PrimitiveSessionIntelOptions,
): SessionIntelPort {
  const ids = options.ids ?? uuidIds;
  const primitive = createSessionIntelPrimitive(options);
  const classify = options.classifySource ?? classifySourceRef;

  return {
    async extract({ sessionId, sourceRef, text, pair }) {
      const run = await runPrimitive({
        primitive,
        trigger: {
          sessionId,
          pairingId: pair.pairingId,
          sourceRef,
          sourceKind: classify(sourceRef),
          text,
        },
        // The pair is already resolved by the effect runner, so re-reading it
        // would be a second query for data we hold. `goals` stays a real read
        // because nothing upstream has it.
        reader: {
          pairContext: async () => pair,
          ...(options.goals ? { goals: options.goals } : {}),
        },
        llm: options.llm,
        policy: pair.policy,
        orgId: pair.orgId,
        ...(options.runs ? { runs: options.runs } : {}),
        // Unanimous consent, checked before the model is reached rather than
        // after (invariant 12): one participant's refusal is not outvoted.
        // `[].every()` is true, and a pair with no participants on record is
        // not a pair that consented to anything.
        inferenceEnabled:
          pair.participants.length > 0 &&
          pair.participants.every((p) => p.consent.aiProcessing),
        ...(options.onWarn ? { onWarn: options.onWarn } : {}),
      });

      return {
        extractionId: ids.next("ext"),
        markdown: renderExtractionMarkdown(run.output, pair, {
          sourceRef,
          degraded: run.degraded,
        }),
        actionItems: actionItemLines(run.output, pair),
        output: run.output,
        gate: run.gate,
        degraded: run.degraded,
        status: "pending",
      };
    },
  };
}

/**
 * `sourceRef` is whatever the transcript adapter or the note event called it.
 * A guess is fine here — it only labels the prompt — but it is a named
 * function so a tenant with odd refs can replace it rather than patch it.
 */
export function classifySourceRef(sourceRef: string): SessionSourceKind {
  const ref = sourceRef.toLowerCase();
  if (ref.includes("transcript") || ref.includes("recording")) return "transcript";
  if (ref.includes("chat") || ref.includes("thread")) return "chat";
  return "notes";
}
