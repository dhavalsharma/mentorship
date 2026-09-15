import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  LlmProvider,
  LlmStructuredRequest,
  LlmUsage,
} from "@mentorship/core";
import { costUsd } from "./cost.js";

/**
 * The shipped default provider. Everything else in the platform talks to the
 * `LlmProvider` port, so swapping vendors is a one-line change at the wiring
 * and nothing else moves.
 *
 * Structured output goes through `output_config.format` rather than asking for
 * JSON in the prompt and hoping: parsing prose is a permanent tax, and the
 * runner's one repair retry exists for the residual case, not as the plan.
 */

export interface AnthropicProviderOptions {
  apiKey?: string;
  /**
   * Defaults to Opus 5. The blueprint's split — cheap model for extraction and
   * classification, strong model for adjudication and drafting — is expressed
   * by constructing two providers, not by branching inside one.
   */
  model?: string;
  maxTokens?: number;
  client?: Anthropic;
}

export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? "claude-opus-5";
    this.maxTokens = options.maxTokens ?? 16000;
    this.client =
      options.client ??
      new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async structured<T>(
    request: LlmStructuredRequest<T>,
  ): Promise<{ value: T; usage: LlmUsage }> {
    const startedAt = Date.now();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      ...(request.system ? { system: request.system } : {}),
      output_config: {
        ...(request.effort ? { effort: request.effort } : {}),
        format: {
          type: "json_schema",
          schema: zodToJsonSchema(request.schema, {
            name: request.schemaName,
            $refStrategy: "none",
          }),
        },
      },
      messages: [{ role: "user", content: request.prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    // A policy decline is a 200 with no usable content, not an exception. The
    // runner turns a throw here into the primitive's deterministic fallback,
    // which is the right outcome for one too.
    if (response.stop_reason === "refusal") {
      throw new Error(
        `model refused: ${response.stop_details?.category ?? "unspecified"}`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const usage: LlmUsage = {
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      costUsd: costUsd(
        response.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
      ),
      latencyMs: Date.now() - startedAt,
    };

    // Parsed and validated here rather than trusted: `json_schema` constrains
    // the shape, and zod is what the rest of the codebase believes.
    return { value: request.schema.parse(JSON.parse(text)), usage };
  }
}
