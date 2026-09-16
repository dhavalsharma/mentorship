import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import { computeHealth, bandFor, rankedShortfalls } from "@mentorship/primitive-progress";
import type { Signal } from "@mentorship/primitive-progress";
import { AS_OF } from "./fixtures.js";

/**
 * ADR-0007 in test form. The score is a weighted composite of observable
 * signals and nothing else, so the question a program admin always asks —
 * "why is this pair amber?" — has an arithmetic answer.
 */

const SUBJECT = "pairing:p_1";

function signal(kind: string, value: number, confidence = 1): Signal {
  return {
    subjectRef: SUBJECT,
    kind,
    value,
    confidence,
    source: `test@v1`,
    observedAt: AS_OF,
  };
}

const policy = defaultPolicy({});

function health(signals: Signal[]) {
  return computeHealth({ subjectRef: SUBJECT, asOf: AS_OF, signals, policy });
}

describe("composite health score", () => {
  it("is the policy-weighted mean of the components present", () => {
    // cadence 0.30 at 1.0 and actionItemCompletion 0.20 at 0.5, renormalised
    // over the 0.50 present: (0.3*1 + 0.2*0.5) / 0.5 = 0.8
    const score = health([
      signal("cadenceAdherence", 1),
      signal("actionItemCompletion", 0.5),
    ]);
    expect(score.score).toBeCloseTo(0.8, 4);
  });

  it("is reproducible: the same signals give the same number, every time", () => {
    const signals = [signal("cadenceAdherence", 0.62), signal("goalVelocity", 0.4)];
    const a = health(signals);
    const b = health(signals);
    expect(a.score).toBe(b.score);
    expect(a.band).toBe(b.band);
    expect(a.components).toEqual(b.components);
  });

  it("moves when a program reweights — proving weights are data, not code", () => {
    const signals = [
      signal("cadenceAdherence", 0),
      signal("surveySentiment", 1),
    ];
    const standard = health(signals);
    const sentimentLed = computeHealth({
      subjectRef: SUBJECT,
      asOf: AS_OF,
      signals,
      policy: defaultPolicy({
        healthWeights: { cadenceAdherence: 0.1, surveySentiment: 0.9 },
      }),
    });

    // Same observations, different program, legitimately different answer.
    expect(standard.score).toBeLessThan(sentimentLed.score);
  });

  it("renormalises over what is present, so a missing component is not a zero", () => {
    // One perfect component and nothing else is a perfect score on thin
    // evidence — the thinness belongs in confidence, not in the number.
    const score = health([signal("cadenceAdherence", 1)]);
    expect(score.score).toBe(1);
    expect(score.confidence).toBeLessThan(1);
    expect(score.missingKinds).toContain("actionItemCompletion");
  });

  it("scores a component that is genuinely zero differently from one that is absent", () => {
    const absent = health([signal("cadenceAdherence", 1)]);
    const zeroed = health([
      signal("cadenceAdherence", 1),
      signal("actionItemCompletion", 0),
    ]);
    expect(zeroed.score).toBeLessThan(absent.score);
  });

  it("is unsure about a pair three days in, rather than confidently wrong", () => {
    const sparse = health([signal("cadenceAdherence", 1, 0.1)]);
    expect(sparse.confidence).toBeLessThan(0.2);
    // And says so out loud rather than showing a green badge.
    expect(sparse.band).toBe("unknown");
  });

  it("lets either coverage or density veto confidence on its own", () => {
    const everythingThin = health(
      ["cadenceAdherence", "actionItemCompletion", "goalVelocity", "reciprocity", "surveySentiment", "responseLatency"].map(
        (k) => signal(k, 0.9, 0.2),
      ),
    );
    const oneSolid = health([signal("cadenceAdherence", 0.9, 1)]);

    expect(everythingThin.coverage).toBeCloseTo(1, 2);
    expect(everythingThin.density).toBeLessThan(0.3);
    expect(everythingThin.confidence).toBeLessThan(0.3);

    expect(oneSolid.density).toBeCloseTo(1, 2);
    expect(oneSolid.coverage).toBeLessThan(0.4);
    expect(oneSolid.confidence).toBeLessThan(0.4);
  });

  it("ignores a component the program has weighted to zero without penalising coverage", () => {
    const opinionated = defaultPolicy({
      healthWeights: { cadenceAdherence: 1, responseLatency: 0 },
    });
    const score = computeHealth({
      subjectRef: SUBJECT,
      asOf: AS_OF,
      signals: [signal("cadenceAdherence", 1)],
      policy: opinionated,
    });
    // "Do not count this" is not the same as "this is missing".
    expect(score.coverage).toBe(1);
    expect(score.missingKinds).not.toContain("responseLatency");
  });

  it("reports a signal it was given but has no weight for, rather than dropping it silently", () => {
    const score = health([
      signal("cadenceAdherence", 1),
      signal("inventedByAContributor", 0.5),
    ]);
    expect(score.unweightedKinds).toContain("inventedByAContributor");
    // But it does not affect the number.
    expect(score.score).toBe(1);
  });

  it("carries the component breakdown, which is the whole answer to 'why amber?'", () => {
    const score = health([
      signal("cadenceAdherence", 0.2),
      signal("actionItemCompletion", 0.9),
    ]);
    const worst = rankedShortfalls(score)[0]!;
    expect(worst.kind).toBe("cadenceAdherence");
    // Every component explains its own arithmetic.
    for (const c of score.components) {
      expect(c.contribution).toBeCloseTo(c.normalisedWeight * c.value, 4);
    }
  });

  it("has no opinion at all when it has been given nothing", () => {
    const score = health([]);
    expect(score.band).toBe("unknown");
    expect(score.confidence).toBe(0);
  });
});

describe("bandFor", () => {
  const thresholds = { green: 0.75, amber: 0.5, minConfidence: 0.35 };

  it("refuses to band a score it is not confident in", () => {
    expect(bandFor(0.95, 0.1, thresholds)).toBe("unknown");
  });

  it("bands green, amber and red once there is enough evidence", () => {
    expect(bandFor(0.9, 0.9, thresholds)).toBe("green");
    expect(bandFor(0.6, 0.9, thresholds)).toBe("amber");
    expect(bandFor(0.2, 0.9, thresholds)).toBe("red");
  });
});
