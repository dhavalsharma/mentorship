import { createHash } from "node:crypto";
import type {
  GateDecision,
  LlmProvider,
  LlmUsage,
  Primitive,
  ProgramPolicy,
} from "@mentorship/core";

/**
 * The one loop all four primitives run through, so there is one place that
 * knows about repair retries, fallbacks, cost accounting and the audit row —
 * rather than four places that each know slightly different things.
 *
 * The contract callers depend on: **this never throws because the model
 * failed.** A refusal, a timeout, a schema violation that survives one repair
 * — all of them end at the primitive's deterministic `fallback`, and the run
 * is recorded either way. A reminder that stops arriving because a vendor is
 * down is a broken platform, not a degraded one.
 */

export interface AiRunRecord {
  orgId: string;
  primitive: string;
  promptVersion: string;
  model: string;
  inputHash: string;
  input?: unknown;
  output?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number;
  error?: string;
}

export interface AiRunSink {
  record(run: AiRunRecord): Promise<void>;
}

/** Discards runs. Fine for tests; in production it means no cost dashboard. */
export class NullAiRunSink implements AiRunSink {
  readonly runs: AiRunRecord[] = [];
  async record(run: AiRunRecord): Promise<void> {
    this.runs.push(run);
  }
}

export interface RunPrimitiveOptions<Trigger, Ctx, Out, Reader> {
  primitive: Primitive<Trigger, Ctx, Out, Reader>;
  trigger: Trigger;
  reader: Reader;
  llm: LlmProvider;
  policy: ProgramPolicy;
  orgId: string;
  runs?: AiRunSink;
  /**
   * Off when the participant has not consented to AI processing. The platform
   * keeps working and the primitive skips — consent that breaks the product
   * when withheld is not a real choice.
   */
  inferenceEnabled?: boolean;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface PrimitiveRun<Out> {
  output: Out;
  gate: GateDecision;
  /** True when the output came from `fallback` rather than the model. */
  degraded: boolean;
  usage?: LlmUsage;
  error?: string;
}

export async function runPrimitive<Trigger, Ctx, Out, Reader>(
  options: RunPrimitiveOptions<Trigger, Ctx, Out, Reader>,
): Promise<PrimitiveRun<Out>> {
  const { primitive, llm, policy, orgId } = options;
  const runs = options.runs ?? new NullAiRunSink();

  const context = await primitive.resolve(options.trigger, options.reader);
  const inputHash = hashOf(context);

  const degrade = async (
    reason: string,
  ): Promise<PrimitiveRun<Out>> => {
    const output = primitive.fallback(context);
    await runs.record({
      orgId,
      primitive: primitive.name,
      promptVersion: primitive.promptVersion,
      model: llm.model,
      inputHash,
      error: reason,
    });
    options.onWarn?.("primitive degraded to fallback", {
      primitive: primitive.name,
      reason,
    });
    return {
      output,
      gate: primitive.gate(output, policy),
      degraded: true,
      error: reason,
    };
  };

  if (options.inferenceEnabled === false) {
    return degrade("ai processing not consented");
  }

  let usage: LlmUsage | undefined;
  const capture: LlmProvider = {
    model: llm.model,
    async structured(request) {
      const result = await llm.structured(request);
      usage = result.usage;
      return result;
    },
    ...(llm.embed ? { embed: llm.embed.bind(llm) } : {}),
  };

  try {
    const output = await primitive.infer(context, capture);
    // Validated again here even though the provider validated: `infer` may
    // assemble its result from several calls, and the schema is the contract
    // the rest of the system was written against.
    const parsed = primitive.outputSchema.parse(output);
    await runs.record({
      orgId,
      primitive: primitive.name,
      promptVersion: primitive.promptVersion,
      model: usage?.model ?? llm.model,
      inputHash,
      output: parsed,
      ...(usage
        ? {
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            costUsd: usage.costUsd,
            latencyMs: usage.latencyMs,
          }
        : {}),
    });
    return {
      output: parsed,
      gate: primitive.gate(parsed, policy),
      degraded: false,
      ...(usage ? { usage } : {}),
    };
  } catch (caught) {
    return degrade(caught instanceof Error ? caught.message : String(caught));
  }
}

/**
 * One repair attempt, then give up and let the caller fall back. A second
 * repair mostly buys another copy of the same mistake at twice the price.
 */
export async function structuredWithRepair<T>(
  llm: LlmProvider,
  request: Parameters<LlmProvider["structured"]>[0] & { schema: import("zod").ZodType<T> },
): Promise<{ value: T; usage: LlmUsage }> {
  try {
    return (await llm.structured(request)) as { value: T; usage: LlmUsage };
  } catch (first) {
    const reason = first instanceof Error ? first.message : String(first);
    return (await llm.structured({
      ...request,
      prompt:
        `${request.prompt}\n\nYour previous answer could not be used: ${reason}\n` +
        `Return only a value matching the schema.`,
    })) as { value: T; usage: LlmUsage };
  }
}

function hashOf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")
    .slice(0, 32);
}
