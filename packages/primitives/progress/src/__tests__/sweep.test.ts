import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import { DeterministicProvider, NullAiRunSink } from "@mentorship/ai";
import { runProgressSweep } from "@mentorship/primitive-progress";
import type { ProgressReader, RiskFinding, RiskFindingsSink } from "@mentorship/primitive-progress";
import { healthyObservations, mixedObservations } from "./fixtures.js";

/**
 * The loop a scheduler would call: one assessment per pairing, every finding
 * written regardless of gate. Whatever ends up calling this on a cadence
 * (the worker's own loop, or pg-boss once ADR-0008's cron path exists) is a
 * scheduling question, not a logic one — which is why it is not tested here.
 */

const policy = defaultPolicy({});

class FakeSink implements RiskFindingsSink {
  written: { orgId: string; pairingId: string; finding: RiskFinding }[] = [];
  async record(input: { orgId: string; pairingId: string; finding: RiskFinding }) {
    this.written.push(input);
  }
}

function readerFor(byPairing: Record<string, ReturnType<typeof healthyObservations>>): ProgressReader {
  return {
    observations: async (trigger) => {
      const found = byPairing[trigger.pairingId];
      if (!found) throw new Error(`no fixture for ${trigger.pairingId}`);
      return found;
    },
  };
}

describe("runProgressSweep", () => {
  it("assesses every pairing given, writing each finding it turns up", async () => {
    const strained = mixedObservations({
      pairingId: "p_strained",
      surveys: [{ at: "2026-09-05T12:00:00.000Z", rating: 0.2 }],
      nextSessionAt: null,
    });
    const healthy = healthyObservations({ pairingId: "p_healthy" });
    const reader = readerFor({ p_strained: strained, p_healthy: healthy });
    const sink = new FakeSink();
    const runs = new NullAiRunSink();

    const result = await runProgressSweep({
      pairingIds: ["p_strained", "p_healthy"],
      reader,
      llm: new DeterministicProvider({ failWith: new Error("no model needed for this test") }),
      policy,
      orgId: "org_1",
      sink,
      runs,
    });

    expect(result.entries).toHaveLength(2);
    const strainedEntry = result.entries.find((e) => e.pairingId === "p_strained")!;
    const healthyEntry = result.entries.find((e) => e.pairingId === "p_healthy")!;

    expect(strainedEntry.risksWritten).toBeGreaterThan(0);
    expect(healthyEntry.risksWritten).toBe(0);
    expect(sink.written.every((w) => w.orgId === "org_1")).toBe(true);
    expect(sink.written.filter((w) => w.pairingId === "p_strained")).toHaveLength(
      strainedEntry.risksWritten,
    );
    expect(runs.runs).toHaveLength(2);
  });

  it("still writes the deterministic findings when the model is unavailable", async () => {
    const strained = mixedObservations({
      pairingId: "p_strained",
      surveys: [{ at: "2026-09-05T12:00:00.000Z", rating: 0.1 }],
      nextSessionAt: null,
    });
    const sink = new FakeSink();

    const result = await runProgressSweep({
      pairingIds: ["p_strained"],
      reader: readerFor({ p_strained: strained }),
      llm: new DeterministicProvider({ failWith: new Error("vendor down") }),
      policy,
      orgId: "org_1",
      sink,
    });

    expect(result.entries[0]!.degraded).toBe(true);
    expect(sink.written.length).toBeGreaterThan(0);
  });

  it("sweeps nobody when given no pairings", async () => {
    const sink = new FakeSink();
    const result = await runProgressSweep({
      pairingIds: [],
      reader: readerFor({}),
      llm: new DeterministicProvider({ failWith: new Error("unused") }),
      policy,
      orgId: "org_1",
      sink,
    });
    expect(result.entries).toEqual([]);
    expect(sink.written).toEqual([]);
  });
});
