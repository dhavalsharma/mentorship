import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultPolicy, type Primitive } from "@mentorship/core";
import {
  DeterministicProvider,
  NullAiRunSink,
  PromptRegistry,
  costUsd,
  runPrimitive,
  structuredWithRepair,
} from "@mentorship/ai";

/**
 * The contract every primitive is written against: the runner does not throw
 * because the model failed. Everything else in this file is downstream of
 * that one promise.
 */

const OutSchema = z.object({ headline: z.string(), confident: z.boolean() });
type Out = z.infer<typeof OutSchema>;

const policy = defaultPolicy({});

function primitive(
  over: Partial<Primitive<{ id: string }, { id: string }, Out, unknown>> = {},
): Primitive<{ id: string }, { id: string }, Out, unknown> {
  return {
    name: "test.primitive",
    promptVersion: "test@v1",
    outputSchema: OutSchema,
    async resolve(trigger) {
      return { id: trigger.id };
    },
    async infer(ctx, llm) {
      const { value } = await llm.structured({
        prompt: `summarise ${ctx.id}`,
        schema: OutSchema,
        schemaName: "Out",
      });
      return value;
    },
    gate: () => "approve",
    fallback: () => ({ headline: "unavailable", confident: false }),
    ...over,
  };
}

describe("runPrimitive", () => {
  it("returns the model's answer and records the run", async () => {
    const runs = new NullAiRunSink();
    const llm = new DeterministicProvider({
      scripted: [{ when: "summarise p1", value: { headline: "went well", confident: true } }],
    });

    const result = await runPrimitive({
      primitive: primitive(),
      trigger: { id: "p1" },
      reader: undefined,
      llm,
      policy,
      orgId: "org_1",
      runs,
    });

    expect(result.output.headline).toBe("went well");
    expect(result.degraded).toBe(false);
    expect(result.gate).toBe("approve");
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({
      primitive: "test.primitive",
      promptVersion: "test@v1",
      tokensIn: 100,
      tokensOut: 50,
    });
  });

  it("falls back rather than throwing when the model is down", async () => {
    const runs = new NullAiRunSink();
    const llm = new DeterministicProvider({ failWith: new Error("503 from vendor") });

    const result = await runPrimitive({
      primitive: primitive(),
      trigger: { id: "p1" },
      reader: undefined,
      llm,
      policy,
      orgId: "org_1",
      runs,
    });

    expect(result.degraded).toBe(true);
    expect(result.output).toEqual({ headline: "unavailable", confident: false });
    // Still gated — a fallback is an answer, and it still needs a decision.
    expect(result.gate).toBe("approve");
    expect(runs.runs[0]!.error).toMatch(/503 from vendor/);
  });

  it("falls back when the model's answer does not fit the schema", async () => {
    const llm = new DeterministicProvider({
      scripted: [{ when: "summarise", value: { headline: 42 } }],
    });
    const result = await runPrimitive({
      primitive: primitive(),
      trigger: { id: "p1" },
      reader: undefined,
      llm,
      policy,
      orgId: "org_1",
    });
    expect(result.degraded).toBe(true);
  });

  it("skips inference entirely when AI processing is not consented", async () => {
    const llm = new DeterministicProvider({
      scripted: [{ when: "summarise", value: { headline: "x", confident: true } }],
    });
    const result = await runPrimitive({
      primitive: primitive(),
      trigger: { id: "p1" },
      reader: undefined,
      llm,
      policy,
      orgId: "org_1",
      inferenceEnabled: false,
    });

    expect(result.degraded).toBe(true);
    expect(result.error).toMatch(/consent/);
    // The point: the model was never called, not that its answer was ignored.
    expect(llm.calls).toHaveLength(0);
  });

  it("hashes the resolved context so identical inputs are recognisable", async () => {
    const runs = new NullAiRunSink();
    const llm = new DeterministicProvider({
      scripted: [{ when: "summarise", value: { headline: "x", confident: true } }],
    });
    const run = () =>
      runPrimitive({
        primitive: primitive(),
        trigger: { id: "p1" },
        reader: undefined,
        llm,
        policy,
        orgId: "org_1",
        runs,
      });
    await run();
    await run();
    expect(runs.runs[0]!.inputHash).toBe(runs.runs[1]!.inputHash);
  });
});

describe("structuredWithRepair", () => {
  it("repairs once, and the retry carries the reason it failed", async () => {
    let attempt = 0;
    const llm = {
      model: "test",
      async structured(request: { prompt: string; schema: z.ZodType<Out> }) {
        attempt++;
        if (attempt === 1) throw new Error("missing field: confident");
        return {
          value: request.schema.parse({ headline: request.prompt.includes("could not be used") ? "repaired" : "first", confident: true }),
          usage: { model: "test", tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 0 },
        };
      },
    };

    const { value } = await structuredWithRepair(llm as never, {
      prompt: "go",
      schema: OutSchema,
      schemaName: "Out",
    });

    expect(attempt).toBe(2);
    expect(value.headline).toBe("repaired");
  });

  it("gives up after one repair rather than looping", async () => {
    let attempt = 0;
    const llm = {
      model: "test",
      async structured() {
        attempt++;
        throw new Error("still wrong");
      },
    };
    await expect(
      structuredWithRepair(llm as never, {
        prompt: "go",
        schema: OutSchema,
        schemaName: "Out",
      }),
    ).rejects.toThrow(/still wrong/);
    expect(attempt).toBe(2);
  });
});

describe("PromptRegistry", () => {
  const registry = new PromptRegistry().register({
    name: "matching.adjudicate",
    version: "v3",
    system: "You compare {{role}} candidates.",
    template: "Mentee: {{mentee}}",
  });

  it("renders by name@version and substitutes variables", () => {
    const rendered = registry.render("matching.adjudicate@v3", {
      role: "mentor",
      mentee: "Priya",
    });
    expect(rendered.ref).toBe("matching.adjudicate@v3");
    expect(rendered.system).toBe("You compare mentor candidates.");
    expect(rendered.prompt).toBe("Mentee: Priya");
  });

  it("throws on a missing variable rather than shipping {{mentee}} to a model", () => {
    expect(() => registry.render("matching.adjudicate@v3", { role: "mentor" })).toThrow(
      /needs a value for \{\{mentee\}\}/,
    );
  });

  it("throws on an unknown prompt ref", () => {
    expect(() => registry.render("nope@v1")).toThrow(/unknown prompt/);
  });
});

describe("costUsd", () => {
  it("prices a known model", () => {
    // 1M in + 1M out on Opus 5 = $5 + $25.
    expect(costUsd("claude-opus-5", 1_000_000, 1_000_000)).toBeCloseTo(30);
  });

  it("returns zero for a model it has never heard of, rather than throwing", () => {
    expect(costUsd("claude-from-the-future", 1000, 1000)).toBe(0);
  });
});
