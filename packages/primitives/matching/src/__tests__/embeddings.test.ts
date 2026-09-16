import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@mentorship/core";
import {
  cosineSimilarity,
  defaultMatchingPolicy,
  embedNarratives,
  narrativeSimilarity,
  type ScoringContext,
} from "@mentorship/primitive-matching";
import { HORIZON_DAYS, makeMentee, makeMentor } from "./fixtures.js";

const ctx = (
  narrativeEmbeddings?: ReadonlyMap<string, number[]>,
): ScoringContext => ({
  policy: defaultMatchingPolicy(),
  horizonDays: HORIZON_DAYS,
  narrativeEmbeddings,
});

describe("cosineSimilarity", () => {
  it("scores identical vectors at the top of the [0,1] range", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("scores orthogonal vectors at the midpoint", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.5, 6);
  });

  it("scores opposite vectors at the bottom of the range", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(0, 6);
  });

  it("does not throw on mismatched-length vectors, returning neutral", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).not.toThrow();
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0.5);
  });

  it("does not throw on zero vectors, returning neutral", () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).not.toThrow();
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0.5);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0.5);
  });

  it("does not throw on empty vectors, returning neutral", () => {
    expect(() => cosineSimilarity([], [])).not.toThrow();
    expect(cosineSimilarity([], [])).toBe(0.5);
  });
});

describe("narrative_similarity scorer", () => {
  const mentee = makeMentee({ participantId: "mentee_1" });
  const mentor = makeMentor({ participantId: "mentor_1" });

  it("contributes 0 with a clear explanation when an embedding is missing", () => {
    const result = narrativeSimilarity.score({ mentee, mentor, ctx: ctx() });
    expect(result.value).toBe(0);
    expect(result.explain).toMatch(/unavailable/);
  });

  it("contributes 0 when only one side has an embedding", () => {
    const embeddings = new Map([["mentee_1", [1, 0, 0]]]);
    const result = narrativeSimilarity.score({ mentee, mentor, ctx: ctx(embeddings) });
    expect(result.value).toBe(0);
    expect(result.explain).toMatch(/unavailable/);
  });

  it("returns a real similarity score when both sides have embeddings", () => {
    const embeddings = new Map([
      ["mentee_1", [1, 0, 0]],
      ["mentor_1", [1, 0, 0]],
    ]);
    const result = narrativeSimilarity.score({ mentee, mentor, ctx: ctx(embeddings) });
    expect(result.value).toBeCloseTo(1, 6);
    expect(result.explain).toMatch(/narrative cosine similarity/);
  });

  it("is not weighted by default (unweighted scorers still run and are measured)", () => {
    const policy = defaultMatchingPolicy();
    expect(policy.weights.narrative_similarity).toBeUndefined();
  });
});

describe("embedNarratives", () => {
  it("skips narrator-less people and calls embed only for the rest", async () => {
    const calls: string[][] = [];
    const fakeLlm: LlmProvider = {
      model: "fake-embedder",
      structured: async () => {
        throw new Error("not used in this test");
      },
      embed: async (texts: string[]) => {
        calls.push(texts);
        return {
          vectors: texts.map((_, i) => [i + 1, 0, 0]),
          usage: { model: "fake-embedder", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
        };
      },
    };

    const result = await embedNarratives(fakeLlm, [
      { participantId: "a", narrative: "wants to grow into staff engineering" },
      { participantId: "b", narrative: "   " },
      { participantId: "c", narrative: "" },
      { participantId: "d", narrative: "loves mentoring on system design" },
    ]);

    expect(calls).toEqual([
      ["wants to grow into staff engineering", "loves mentoring on system design"],
    ]);
    expect(result.has("a")).toBe(true);
    expect(result.has("d")).toBe(true);
    expect(result.has("b")).toBe(false);
    expect(result.has("c")).toBe(false);
    expect(result.size).toBe(2);
  });

  it("returns an empty map, not a throw, when everyone's narrative is blank", async () => {
    const fakeLlm: LlmProvider = {
      model: "fake-embedder",
      structured: async () => {
        throw new Error("not used in this test");
      },
      embed: async () => {
        throw new Error("embed should not be called with no narratives");
      },
    };

    const result = await embedNarratives(fakeLlm, [{ participantId: "a", narrative: "" }]);
    expect(result.size).toBe(0);
  });

  it("returns an empty map, not a throw, when the provider has no embed method", async () => {
    const fakeLlm: LlmProvider = {
      model: "fake-no-embed",
      structured: async () => {
        throw new Error("not used in this test");
      },
    };

    const result = await embedNarratives(fakeLlm, [
      { participantId: "a", narrative: "some narrative" },
    ]);
    expect(result.size).toBe(0);
  });
});
