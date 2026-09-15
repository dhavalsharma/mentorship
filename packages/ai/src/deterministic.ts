import type {
  LlmProvider,
  LlmStructuredRequest,
  LlmUsage,
} from "@mentorship/core";

/**
 * The provider every test uses. Not a mock in the usual sense — it is a real
 * `LlmProvider` whose answers are a function of the prompt, so a test can
 * assert on behaviour around the model without a network, an API key, or a
 * different answer on Tuesday.
 *
 * `scripted` matches on a substring of the prompt, which is enough to express
 * "when asked about this pair, say that" without pretending to be a model.
 */

export interface ScriptedResponse {
  /** Matched against the prompt; the first match wins. */
  when: string | RegExp;
  value: unknown;
}

export interface DeterministicProviderOptions {
  model?: string;
  scripted?: ScriptedResponse[];
  /** Used when nothing matches. Throwing is the default, loudly. */
  fallbackValue?: unknown;
  /** Makes the failure path testable without a real outage. */
  failWith?: Error;
  tokensIn?: number;
  tokensOut?: number;
}

export class DeterministicProvider implements LlmProvider {
  readonly model: string;
  readonly calls: LlmStructuredRequest<unknown>[] = [];

  constructor(private readonly options: DeterministicProviderOptions = {}) {
    this.model = options.model ?? "deterministic";
  }

  async structured<T>(
    request: LlmStructuredRequest<T>,
  ): Promise<{ value: T; usage: LlmUsage }> {
    this.calls.push(request as LlmStructuredRequest<unknown>);

    if (this.options.failWith) throw this.options.failWith;

    const match = (this.options.scripted ?? []).find((s) =>
      typeof s.when === "string"
        ? request.prompt.includes(s.when)
        : s.when.test(request.prompt),
    );
    const raw = match ? match.value : this.options.fallbackValue;
    if (raw === undefined) {
      throw new Error(
        `DeterministicProvider has no scripted answer for "${request.schemaName}"`,
      );
    }

    // Validated like a real provider's output would be, so a test fixture that
    // does not satisfy the schema fails here rather than three layers later.
    const usage: LlmUsage = {
      model: this.model,
      tokensIn: this.options.tokensIn ?? 100,
      tokensOut: this.options.tokensOut ?? 50,
      costUsd: 0,
      latencyMs: 0,
    };
    return { value: request.schema.parse(raw), usage };
  }
}
