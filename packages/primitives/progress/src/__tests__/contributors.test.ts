import { describe, expect, it } from "vitest";
import { addDays, defaultPolicy } from "@mentorship/core";
import {
  CONFIDENCE_SATURATION,
  SignalContributorRegistry,
  collectSignals,
  defaultSignalRegistry,
  latestByKind,
  seriesOf,
  type SignalContributor,
} from "@mentorship/primitive-progress";
import { z } from "zod";
import { AS_OF, at, MENTEE, MENTOR, mixedObservations, observations } from "./fixtures.js";

const kinds = (signals: { kind: string }[]) => [...new Set(signals.map((s) => s.kind))].sort();
const valueOf = (signals: Parameters<typeof latestByKind>[0], kind: string) =>
  latestByKind(signals).get(kind);

describe("cadence adherence", () => {
  it("scores sessions held against what the cadence expected", () => {
    const { signals } = collectSignals(mixedObservations());
    const latest = valueOf(signals, "cadenceAdherence");
    // Three sessions in the trailing three fortnights is exactly on cadence.
    expect(latest?.value).toBe(1);
    expect(latest?.confidence).toBe(1);
  });

  it("emits a series, one sample per cadence interval, oldest first", () => {
    const series = seriesOf(collectSignals(mixedObservations()).signals, "cadenceAdherence");
    expect(series).toHaveLength(3);
    expect(series.map((s) => s.value)).toEqual([0.3333, 0.6667, 1]);
  });

  it("counts a no-show against adherence — nothing happened either way", () => {
    const withNoShow = mixedObservations({
      sessions: [
        { sessionId: "s_1", at: at(38), outcome: "held" },
        { sessionId: "s_2", at: at(24), outcome: "no_show" },
        { sessionId: "s_3", at: at(10), outcome: "cancelled" },
      ],
    });
    expect(valueOf(collectSignals(withNoShow).signals, "cadenceAdherence")?.value).toBe(
      0.3333,
    );
  });

  it("pro-rates a pair that is younger than the window, and says so in confidence", () => {
    const young = observations({ startedAt: at(3), sessions: [] });
    const latest = valueOf(collectSignals(young).signals, "cadenceAdherence");
    // 3 days of a 42-day window: the number exists, and is worth almost nothing.
    expect(latest?.confidence).toBe(0.0714);
    expect(seriesOf(collectSignals(young).signals, "cadenceAdherence")).toHaveLength(1);
  });

  it("abstains entirely for an ad-hoc program, rather than inventing a standard", () => {
    const policy = defaultPolicy({ cadence: { everyDays: 0, label: "ad-hoc" } });
    const adhoc = mixedObservations({ policy, cadence: policy.cadence });
    const collected = collectSignals(adhoc);
    expect(kinds(collected.signals)).not.toContain("cadenceAdherence");
    expect(collected.abstained.map((a) => a.kind)).toContain("cadenceAdherence");
  });
});

describe("action-item completion", () => {
  it("is closed over created inside the rolling window", () => {
    const latest = valueOf(collectSignals(mixedObservations()).signals, "actionItemCompletion");
    expect(latest?.value).toBe(0.75);
    expect(latest?.confidence).toBe(4 / CONFIDENCE_SATURATION.actionItems);
  });

  it("ignores items created before the window, so an old ghost stops counting", () => {
    const ancient = mixedObservations({
      actionItems: [
        { id: "old", createdAt: at(120), closedAt: null, dueAt: null },
        { id: "new", createdAt: at(5), closedAt: at(4), dueAt: null },
      ],
    });
    expect(valueOf(collectSignals(ancient).signals, "actionItemCompletion")?.value).toBe(1);
  });

  it("abstains when there were no action items at all", () => {
    const none = mixedObservations({ actionItems: [] });
    expect(kinds(collectSignals(none).signals)).not.toContain("actionItemCompletion");
  });
});

describe("goal velocity", () => {
  it("measures progress against the pace the horizon implies", () => {
    // Halfway to the target date with a quarter recorded: velocity 0.5.
    const latest = valueOf(collectSignals(mixedObservations()).signals, "goalVelocity");
    expect(latest?.value).toBe(0.5);
    expect(latest?.confidence).toBe(0.6667);
  });

  it("does not punish a new goal with a distant horizon", () => {
    const early = mixedObservations({
      goals: [
        {
          goalId: "g_1",
          openedAt: at(10),
          targetAt: addDays(AS_OF, 170),
          checkIns: [{ at: at(1), progress: 0.06 }],
        },
      ],
    });
    expect(valueOf(collectSignals(early).signals, "goalVelocity")?.value).toBe(1);
  });

  it("abstains for goals with no horizon — there is no pace to be behind", () => {
    const openEnded = mixedObservations({
      goals: [{ goalId: "g_1", openedAt: at(50), targetAt: null, checkIns: [] }],
    });
    expect(kinds(collectSignals(openEnded).signals)).not.toContain("goalVelocity");
  });
});

describe("reciprocity", () => {
  it("scores balance per activity kind and averages them", () => {
    // notes 3:1 -> 0.5; scheduling 2:0 -> 0; mean 0.25.
    const latest = valueOf(collectSignals(mixedObservations()).signals, "reciprocity");
    expect(latest?.value).toBe(0.25);
  });

  it("scores a participant who never appears as a zero, not as absent", () => {
    const oneSided = mixedObservations({
      activity: [
        { at: at(5), actorRef: MENTOR, actorRole: "mentor", kind: "note_logged" },
        { at: at(4), actorRef: MENTOR, actorRole: "mentor", kind: "note_logged" },
      ],
    });
    expect(valueOf(collectSignals(oneSided).signals, "reciprocity")?.value).toBe(0);
  });

  it("never puts a participant reference in the basis it will be explained with", () => {
    const contribution = collectSignals(mixedObservations()).contributions.find(
      (c) => c.signal.kind === "reciprocity",
    );
    expect(contribution?.basis).toBeDefined();
    expect(contribution?.basis).not.toContain(MENTOR);
    expect(contribution?.basis).not.toContain(MENTEE);
  });
});

describe("survey sentiment", () => {
  it("is the aggregate of ratings and carries no respondent", () => {
    const latest = valueOf(collectSignals(mixedObservations()).signals, "surveySentiment");
    expect(latest?.value).toBe(0.7);
    expect(latest?.confidence).toBe(0.5);
  });
});

describe("response latency", () => {
  it("uses the median against the program's own response expectation", () => {
    // median 24h against a 48h policy expectation.
    const latest = valueOf(collectSignals(mixedObservations()).signals, "responseLatency");
    expect(latest?.value).toBe(0.5);
  });

  it("moves when the program changes what it expects — policy, not a constant", () => {
    const strict = defaultPolicy({ agreement: { responseTimeoutHours: 24 } });
    const observed = mixedObservations({ policy: strict });
    expect(valueOf(collectSignals(observed).signals, "responseLatency")?.value).toBe(0);
  });
});

describe("the registry", () => {
  it("emits every component the default program weights", () => {
    const collected = collectSignals(mixedObservations());
    expect(kinds(collected.signals)).toEqual([
      "actionItemCompletion",
      "cadenceAdherence",
      "goalVelocity",
      "reciprocity",
      "responseLatency",
      "surveySentiment",
    ]);
    expect(collected.abstained).toEqual([]);
  });

  it("records why a contributor said nothing, so a blank dashboard is diagnosable", () => {
    const bare = observations();
    const collected = collectSignals(bare);
    expect(collected.abstained.map((a) => a.kind).sort()).toEqual([
      "actionItemCompletion",
      "goalVelocity",
      "reciprocity",
      "responseLatency",
      "surveySentiment",
    ]);
  });

  it("isolates a contributor that throws instead of losing the whole score", () => {
    const exploding: SignalContributor<{ ok: boolean }> = {
      kind: "explodes",
      version: "v1",
      inputSchema: z.object({ ok: z.boolean() }),
      select: () => ({ ok: true }),
      contribute() {
        throw new Error("upstream query timed out");
      },
    };
    const registry = defaultSignalRegistry().register(exploding);
    const collected = collectSignals(mixedObservations(), registry);

    expect(collected.signals.length).toBeGreaterThan(0);
    expect(collected.abstained).toContainEqual({
      kind: "explodes",
      reason: "upstream query timed out",
    });
  });

  it("refuses two contributors for the same kind", () => {
    const registry = defaultSignalRegistry();
    expect(() =>
      registry.register({
        kind: "reciprocity",
        version: "v2",
        inputSchema: z.object({}),
        select: () => ({}),
        contribute: () => [],
      }),
    ).toThrow(/already registered/);
  });

  it("rejects a contributor that emits a value outside the shared 0..1 scale", () => {
    const shouty: SignalContributor<Record<string, never>> = {
      kind: "shouty",
      version: "v1",
      inputSchema: z.object({}),
      select: () => ({}),
      contribute: (_input, ctx) => [
        {
          signal: {
            subjectRef: ctx.subjectRef,
            kind: "shouty",
            value: 9,
            confidence: 1,
            source: "progress.shouty@v1",
            observedAt: ctx.asOf,
          },
          basis: "turned up to eleven",
          sampleSize: 1,
        },
      ],
    };
    const collected = collectSignals(
      mixedObservations(),
      new SignalContributorRegistry().register(shouty),
    );
    expect(collected.signals).toEqual([]);
    expect(collected.abstained[0]?.kind).toBe("shouty");
  });

  it("stamps a versioned source on every signal, so an old score stays explicable", () => {
    for (const signal of collectSignals(mixedObservations()).signals) {
      expect(signal.source).toBe(`progress.${signal.kind}@v1`);
    }
  });
});
