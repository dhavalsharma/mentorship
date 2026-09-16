import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_WINDOW_DAYS,
  GreedyBandit,
  ThompsonBandit,
  attributeOutcome,
  betaSample,
  outcomeFromDecision,
  rewardOf,
  seededRng,
  tallyTemplates,
  type NudgeDecision,
  type NudgeOutcome,
} from "@mentorship/primitive-nudge";

/**
 * The learning loop. Two properties matter: it is replayable (a seeded run
 * produces the same choices, or nobody can tell a copy regression from a
 * dice roll), and it actually moves toward the arm that works.
 */

const ARMS = ["a", "b", "c"];

describe("seededRng", () => {
  it("produces the same stream for the same seed and a different one otherwise", () => {
    const draw = (seed: number) => {
      const rng = seededRng(seed);
      return [rng.next(), rng.next(), rng.next()];
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
    for (const v of draw(7)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("betaSample", () => {
  it("stays inside [0, 1] and concentrates where the evidence is", () => {
    const rng = seededRng(1);
    const draws = Array.from({ length: 200 }, () => betaSample(30, 3, rng));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThanOrEqual(1);
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.8); // true mean 30/33
  });
});

describe("ThompsonBandit", () => {
  it("is deterministic under a seeded sampler", () => {
    const stats = [{ templateId: "a", wins: 3, losses: 1 }];
    const first = new ThompsonBandit(seededRng(99)).rank(ARMS, stats);
    const second = new ThompsonBandit(seededRng(99)).rank(ARMS, stats);
    expect(first.map((r) => r.templateId)).toEqual(second.map((r) => r.templateId));
    expect(first.map((r) => r.score)).toEqual(second.map((r) => r.score));
  });

  it("converges on the arm that books sessions", () => {
    const stats = [
      { templateId: "a", wins: 40, losses: 5 },
      { templateId: "b", wins: 2, losses: 40 },
      { templateId: "c", wins: 1, losses: 30 },
    ];
    const rng = seededRng(5);
    const bandit = new ThompsonBandit(rng);
    const wins = ARMS.map((arm) => ({ arm, n: 0 }));
    for (let i = 0; i < 200; i++) {
      const top = bandit.rank(ARMS, stats)[0]!.templateId;
      wins.find((w) => w.arm === top)!.n += 1;
    }
    expect(wins.find((w) => w.arm === "a")!.n).toBeGreaterThan(180);
  });

  it("explores evenly when it knows nothing, rather than locking onto the first arm", () => {
    const bandit = new ThompsonBandit(seededRng(11));
    const counts = new Map(ARMS.map((a) => [a, 0]));
    for (let i = 0; i < 300; i++) {
      const top = bandit.rank(ARMS, [])[0]!.templateId;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    // A uniform prior means roughly a third each; the loose bound is the
    // assertion that no arm is starved, not a claim about the exact split.
    for (const arm of ARMS) expect(counts.get(arm)!).toBeGreaterThan(50);
  });

  it("treats an unseen arm as unknown, not as a loser", () => {
    const ranked = new ThompsonBandit(seededRng(3)).rank(["known", "new"], [
      { templateId: "known", wins: 1, losses: 1 },
    ]);
    expect(ranked.find((r) => r.templateId === "new")!.stat).toEqual({
      templateId: "new",
      wins: 0,
      losses: 0,
    });
  });
});

describe("GreedyBandit", () => {
  it("picks the best observed rate with no exploration at all", () => {
    const ranked = new GreedyBandit().rank(ARMS, [
      { templateId: "a", wins: 1, losses: 9 },
      { templateId: "b", wins: 8, losses: 2 },
    ]);
    expect(ranked[0]!.templateId).toBe("b");
  });
});

// ---------------------------------------------------------------------------

const decision: NudgeDecision = {
  deficit: "pair.cadence_deficit",
  pairingId: "p_001",
  subjectRef: "pairing:p_001",
  dedupeKey: "pairing:p_001:cadence_deficit:2026-W39",
  outcome: "send",
  plan: {
    recipientParticipantId: "pt_mentee",
    recipientRole: "mentee",
    channel: "dm",
    tone: "gentle",
    templateId: "cadence.gentle.streak",
    body: "hello",
    rationale: "quietest",
    evidence: [],
  },
  gates: [],
  dropReason: null,
  event: "nudge.planned",
  nextEligibleAt: null,
};

const sent: NudgeOutcome = outcomeFromDecision({
  decision,
  nudgeId: "n_1",
  orgId: "org_1",
  sentAt: "2026-09-21T14:00:00.000Z",
});

describe("outcome attribution", () => {
  it("carries the arm that produced it, or the label is worthless", () => {
    expect(sent.templateId).toBe("cadence.gentle.streak");
    expect(sent.tone).toBe("gentle");
    expect(sent.bookedWithin7Days).toBeNull();
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(7);
  });

  it("stays unresolved while the window is open", () => {
    const still = attributeOutcome({
      outcome: sent,
      bookedAt: [],
      now: "2026-09-25T00:00:00.000Z",
    });
    expect(still.bookedWithin7Days).toBeNull();
    expect(rewardOf(still)).toBeNull();
  });

  it("counts a booking inside the window and ignores one outside it", () => {
    const won = attributeOutcome({
      outcome: sent,
      bookedAt: ["2026-09-23T09:00:00.000Z"],
      now: "2026-09-23T10:00:00.000Z",
    });
    expect(won.bookedWithin7Days).toBe(true);
    expect(rewardOf(won)).toBe(1);

    const late = attributeOutcome({
      outcome: sent,
      bookedAt: ["2026-10-05T09:00:00.000Z"],
      now: "2026-10-06T00:00:00.000Z",
    });
    expect(late.bookedWithin7Days).toBe(false);
    // Resolved at the window's edge, not at `now` — otherwise the label date
    // depends on when the job happened to run.
    expect(late.resolvedAt).toBe("2026-09-28T14:00:00.000Z");
  });

  it("is idempotent: a later booking does not rewrite a settled loss", () => {
    const lost = attributeOutcome({
      outcome: sent,
      bookedAt: [],
      now: "2026-10-01T00:00:00.000Z",
    });
    const again = attributeOutcome({
      outcome: lost,
      bookedAt: ["2026-09-22T09:00:00.000Z"],
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(again).toEqual(lost);
  });

  it("tallies resolved outcomes into stats the bandit can rank, skipping open ones", () => {
    const stats = tallyTemplates([
      { ...sent, nudgeId: "n_1", bookedWithin7Days: true },
      { ...sent, nudgeId: "n_2", bookedWithin7Days: false },
      { ...sent, nudgeId: "n_3", templateId: "cadence.gentle.short", bookedWithin7Days: true },
      { ...sent, nudgeId: "n_4", bookedWithin7Days: null },
    ]);
    expect(stats).toEqual([
      { templateId: "cadence.gentle.short", wins: 1, losses: 0 },
      { templateId: "cadence.gentle.streak", wins: 1, losses: 1 },
    ]);
  });
});
