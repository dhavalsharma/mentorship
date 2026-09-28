import { describe, expect, it } from "vitest";
import { NullAiRunSink, runPrimitive } from "@mentorship/ai";
import {
  defaultPolicy,
  type LlmProvider,
  type LlmStructuredRequest,
  type LlmUsage,
} from "@mentorship/core";
import {
  createPrimitiveSessionIntel,
  createSessionIntelPrimitive,
  PROMPT_REF,
  type SessionIntelReader,
} from "@mentorship/primitive-session-intel";
import { TRANSCRIPT, pairFixture } from "./fixtures.js";

/**
 * The one eval-shaped guarantee that belongs in the gate, because it is
 * deterministic (docs/e2e-testing-strategy.md, tier 5): `runPrimitive` never
 * throws because the model failed. `run.test.ts` proves it for a toy
 * primitive and `primitive.test.ts` for a generic outage and a schema miss;
 * this names the three ways a real provider actually fails — a refusal (a 200
 * with `stop_reason: "refusal"`, which `AnthropicProvider` turns into a
 * throw), a timeout (the SDK's own deadline firing), and a reply that is not
 * valid against the schema on both the attempt and the one repair — and
 * proves each lands on session-intel's deterministic `fallback`, recorded,
 * gated, and still `pending` through the adapter the worker actually calls.
 *
 * What this cannot prove: a provider that never settles. `runPrimitive` has
 * no deadline of its own and relies on the provider's (the Anthropic SDK's is
 * minutes, not seconds). That is a real gap, noted in docs/vendor-contracts.md.
 */

type Mode = "refuse" | "timeout" | "garbage-twice";

class HostileProvider implements LlmProvider {
  readonly model = "hostile";
  calls = 0;
  constructor(private readonly mode: Mode) {}

  async structured<T>(request: LlmStructuredRequest<T>): Promise<{ value: T; usage: LlmUsage }> {
    this.calls++;
    switch (this.mode) {
      case "refuse":
        // Exactly what AnthropicProvider throws on stop_reason "refusal".
        throw new Error("model refused: policy");
      case "timeout": {
        const error = new Error("Request timed out.");
        error.name = "APIConnectionTimeoutError";
        throw error;
      }
      case "garbage-twice": {
        // First: not JSON at all. Then, on the repair: JSON, wrong shape.
        const text = this.calls === 1 ? "{\"summary\": [\"unterminated" : "{\"summary\": 42, \"riskFlags\": \"all\"}";
        return {
          value: request.schema.parse(JSON.parse(text)),
          usage: { model: this.model, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 0 },
        };
      }
    }
  }
}

const reader: SessionIntelReader = {
  async pairContext() {
    return pairFixture();
  },
  async goals() {
    return [{ goalRef: "goal_1", title: "promotion packet" }];
  },
};

const trigger = {
  sessionId: "sess_1",
  pairingId: "pair_1",
  sourceRef: "transcript:fake:1",
  sourceKind: "transcript" as const,
  text: TRANSCRIPT,
};

describe.each<Mode>(["refuse", "timeout", "garbage-twice"])("a hostile provider (%s)", (mode) => {
  it("reaches session-intel's fallback through runPrimitive, recorded and gated", async () => {
    const primitive = createSessionIntelPrimitive();
    const expected = primitive.fallback(await primitive.resolve(trigger, reader));
    const llm = new HostileProvider(mode);
    const runs = new NullAiRunSink();

    const result = await runPrimitive({
      primitive,
      trigger,
      reader,
      llm,
      policy: defaultPolicy({}),
      orgId: "org_1",
      runs,
      subjectId: "ext_1",
    });

    expect(result.degraded).toBe(true);
    expect(result.output).toEqual(expected);
    // The fallback never raises a risk flag, so a failed model can never
    // escalate — nor silently suppress an escalation it never detected.
    expect(result.gate).toBe("approve");
    // One attempt, one repair, then stop — for every failure mode.
    expect(llm.calls).toBe(2);
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      promptVersion: PROMPT_REF,
      model: "hostile",
      subjectId: "ext_1",
      error: expect.any(String),
    });
  });

  it("still yields a pending extraction through the adapter the worker calls", async () => {
    const intel = createPrimitiveSessionIntel({ llm: new HostileProvider(mode) });
    const result = await intel.extract({
      sessionId: "sess_1",
      sourceRef: "transcript:fake:1",
      text: TRANSCRIPT,
      pair: pairFixture(),
    });
    expect(result).toMatchObject({ degraded: true, status: "pending", safeguarding: false });
    expect(result.actionItems.length).toBeGreaterThan(0);
  });
});
