import { describe, expect, it } from "vitest";
import { DeterministicProvider, NullAiRunSink } from "@mentorship/ai";
import { sequentialIds, type PairContext } from "@mentorship/core";
import {
  classifySourceRef,
  createPrimitiveSessionIntel,
  renderExtractionMarkdown,
  type SessionIntelOutput,
} from "@mentorship/primitive-session-intel";
import { TRANSCRIPT, pairFixture, spanOf } from "./fixtures.js";

/**
 * The drop-in for `heuristicSessionIntel`. The contract that matters is the
 * one the effect runner already calls, so the first test here is a
 * compile-time assignability check against a copy of that interface.
 */

/**
 * Copied verbatim from `SessionIntel` in `packages/workflows/src/effects.ts`
 * rather than imported: a primitive importing `workflows` inverts the
 * dependency direction (invariant 2) and makes the two packages circular. If
 * the seam there changes, this assignment stops compiling — which is the
 * warning we want.
 */
interface WorkflowsSessionIntel {
  extract(input: {
    sessionId: string;
    sourceRef: string;
    text: string;
    pair: PairContext;
  }): Promise<{ extractionId: string; markdown: string; actionItems: string[] }>;
}

const ANSWER: SessionIntelOutput = {
  summary: ["Priya is preparing a promotion packet; Sam will review it."],
  actionItems: [
    {
      owner: "part_mentor",
      text: "Review the draft packet and send comments",
      dueHint: "by Friday",
      evidence: spanOf(
        TRANSCRIPT,
        "I'll review your draft packet by Friday and send comments.",
      ),
    },
    {
      owner: "unassigned",
      text: "Write up the metrics section",
      dueHint: null,
      evidence: spanOf(TRANSCRIPT, "I will write it up before we next meet."),
    },
  ],
  goalProgress: [
    {
      goalRef: "goal_1",
      direction: "advanced",
      note: "Draft exists and is going out for review.",
      evidence: spanOf(TRANSCRIPT, "The promotion packet is still the main thing"),
    },
  ],
  blockers: [
    {
      text: "Metrics are not available from the data team",
      evidence: spanOf(
        TRANSCRIPT,
        "I'm blocked on getting the metrics from the data team.",
      ),
    },
  ],
  sentimentBand: "positive",
  riskFlags: ["relationship_mismatch"],
  nextSessionPrep: ["Bring the reviewed packet."],
};

function intel(over: { llm?: DeterministicProvider; runs?: NullAiRunSink } = {}) {
  const llm =
    over.llm ??
    new DeterministicProvider({
      scripted: [{ when: "BEGIN SESSION RECORD", value: ANSWER }],
    });
  return {
    llm,
    port: createPrimitiveSessionIntel({
      llm,
      ids: sequentialIds(),
      goals: async () => [{ goalRef: "goal_1", title: "promotion packet" }],
      ...(over.runs ? { runs: over.runs } : {}),
    }),
  };
}

const input = (pair: PairContext) => ({
  sessionId: "sess_1",
  sourceRef: "transcript:fake:1",
  text: TRANSCRIPT,
  pair,
});

describe("createPrimitiveSessionIntel", () => {
  it("satisfies the interface the effect runner already calls", () => {
    const port: WorkflowsSessionIntel = intel().port;
    expect(typeof port.extract).toBe("function");
  });

  it("returns the extractionId, markdown and action items the saga emits", async () => {
    const { port } = intel();
    const result = await port.extract(input(pairFixture()));

    expect(result.extractionId).toBe("ext_001");
    expect(result.actionItems).toEqual([
      "Sam Okafor: Review the draft packet and send comments (by Friday)",
      "Unassigned: Write up the metrics section",
    ]);
    expect(result.markdown).toContain("## Action items");
  });

  it("lands pending, never confirmed", async () => {
    const { port } = intel();
    const result = await port.extract(input(pairFixture()));
    expect(result.status).toBe("pending");
    expect(result.gate).toBe("approve");
    expect(result.markdown).toMatch(/not yet reviewed/);
  });

  it("hands the structured record back alongside the markdown", async () => {
    // The markdown is a projection (ADR-0005). Anything that needs the facts —
    // the confirm step, the risk router, the eval harness — reads the record,
    // not a re-parse of the rendering.
    const { port } = intel();
    const result = await port.extract(input(pairFixture()));
    expect(result.output.blockers[0]!.evidence.quote).toContain("blocked on getting");
  });

  it("skips the model when a participant has not consented, without being told to", async () => {
    const { port, llm } = intel();
    const result = await port.extract(input(pairFixture({ aiProcessing: false })));

    expect(llm.calls).toHaveLength(0);
    expect(result.degraded).toBe(true);
    expect(result.markdown).toMatch(/without a model \(degraded\)/);
    // The session is still documented — consent that breaks the product when
    // withheld is not a real choice.
    expect(result.actionItems.length).toBeGreaterThan(0);
  });

  it("still produces a document when the vendor is down", async () => {
    const llm = new DeterministicProvider({ failWith: new Error("503") });
    const { port } = intel({ llm });
    const result = await port.extract(input(pairFixture()));

    expect(result.degraded).toBe(true);
    expect(result.markdown).toContain("## Action items");
  });

  it("records the run for the cost dashboard", async () => {
    const runs = new NullAiRunSink();
    const { port } = intel({ runs });
    await port.extract(input(pairFixture()));
    expect(runs.runs[0]).toMatchObject({ primitive: "session.intel", orgId: "org_1" });
  });
});

describe("renderExtractionMarkdown", () => {
  const pair = pairFixture();

  it("shows the evidence next to the claim", async () => {
    const md = renderExtractionMarkdown(ANSWER, pair, { sourceRef: "t:1" });
    expect(md).toContain("> I'll review your draft packet by Friday and send comments.");
    expect(md).toContain("- [ ] **Sam Okafor**: Review the draft packet");
  });

  it("keeps risk flags out of the document the pair reads", () => {
    const md = renderExtractionMarkdown(
      { ...ANSWER, riskFlags: ["relationship_mismatch", "safeguarding"] },
      pair,
      { sourceRef: "t:1" },
    );
    expect(md).not.toContain("relationship_mismatch");
    expect(md).not.toContain("safeguarding");
  });

  it("reports one sentiment band for the session and attributes it to nobody", () => {
    const md = renderExtractionMarkdown(ANSWER, pair, { sourceRef: "t:1" });
    expect(md).toContain("_Session tone: positive._");
    expect(md).not.toMatch(/Priya Nair.*positive|positive.*Priya Nair/);
  });

  it("says so when there was nothing to capture", () => {
    const md = renderExtractionMarkdown(
      { ...ANSWER, summary: [], actionItems: [], goalProgress: [], blockers: [] },
      pair,
      { sourceRef: "notes:9" },
    );
    expect(md).toMatch(/Nothing was captured/);
    expect(md).toMatch(/None detected/);
  });

  it("names an unknown owner ref 'Unassigned' rather than printing the ref", () => {
    const md = renderExtractionMarkdown(
      {
        ...ANSWER,
        actionItems: [{ ...ANSWER.actionItems[0]!, owner: "part_ghost" }],
      },
      pair,
      { sourceRef: "t:1" },
    );
    expect(md).not.toContain("part_ghost");
    expect(md).toContain("**Unassigned**");
  });
});

describe("classifySourceRef", () => {
  it("labels the prompt from whatever the adapter called the source", () => {
    expect(classifySourceRef("transcript:zoom:abc")).toBe("transcript");
    expect(classifySourceRef("slack-thread:123")).toBe("chat");
    expect(classifySourceRef("note_42")).toBe("notes");
  });
});
