import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiRuns, organizations } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { PostgresAiRunSink } from "@mentorship/ai/postgres";
import type { MatchingOutput } from "@mentorship/primitive-matching";
import { getMatchingRoundCandidates } from "../postgres-reads.js";

/**
 * `getMatchingRoundCandidates` against a real database. Skipped without
 * DATABASE_URL — see packages/db/src/testing.ts.
 *
 * Every matching round's full candidate set (winners and losers, with
 * features/explanation) already round-trips into `ai_runs.output` via
 * `PostgresAiRunSink` (see `packages/primitives/matching/src/round.ts`), so
 * the setup here is exactly that write path — `record()`, then read the id
 * Postgres assigned — rather than a hand-rolled insert that could drift from
 * what `runMatchingRound` actually produces.
 */

const output: MatchingOutput = {
  cohortId: "cohort-1",
  orgId: "placeholder", // overwritten per-test with the real orgId
  asOf: "2026-10-01T00:00:00.000Z",
  solver: "min_cost_flow",
  adjudicated: false,
  adjudicationErrors: 0,
  assignments: [
    {
      menteeId: "mentee_a",
      mentorId: "mentor_a",
      score: 0.9,
      deterministicScore: 0.9,
      rank: 1,
      rationale: null,
      riskFlags: [],
    },
  ],
  unmatched: [],
  mentorLoad: [{ mentorId: "mentor_a", assigned: 1, priorLoad: 0, capacity: 2 }],
  candidates: [
    {
      menteeId: "mentee_a",
      mentorId: "mentor_a",
      eligible: true,
      violations: [],
      features: { skill_fit: 0.8 },
      explanations: { skill_fit: "great fit" },
      deterministicScore: 0.9,
      adjustment: 0,
      adjustedScore: 0.9,
      rank: 1,
      shortlisted: true,
      rationale: "best available fit",
      riskFlags: [],
      evidence: [],
    },
    {
      // The loser — the row an appeal ("why not mentor_b?") is actually for.
      menteeId: "mentee_a",
      mentorId: "mentor_b",
      eligible: true,
      violations: [],
      features: { skill_fit: 0.4 },
      explanations: { skill_fit: "weaker fit" },
      deterministicScore: 0.5,
      adjustment: 0,
      adjustedScore: 0.5,
      rank: 2,
      shortlisted: true,
      rationale: null,
      riskFlags: [],
      evidence: [],
    },
  ],
};

describe.skipIf(!DATABASE_URL)("getMatchingRoundCandidates", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  let matchingRunId: string;
  let nonMatchingRunId: string;

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Matching reads", slug: `matching-reads-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Other org", slug: `other-org-${otherOrgId.slice(0, 8)}` },
    ]);

    const sink = new PostgresAiRunSink(handle.db);
    await sink.record({
      orgId,
      primitive: "matching.propose",
      promptVersion: "v1",
      model: "deterministic",
      inputHash: "hash-1",
      output: { ...output, orgId },
    });
    await sink.record({
      orgId,
      primitive: "session-intel.extract",
      promptVersion: "v1",
      model: "deterministic",
      inputHash: "hash-2",
      output: { some: "unrelated shape" },
    });

    const rows = await handle.db.select().from(aiRuns).where(eq(aiRuns.orgId, orgId));
    matchingRunId = rows.find((r) => r.primitive === "matching.propose")!.id;
    nonMatchingRunId = rows.find((r) => r.primitive === "session-intel.extract")!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(aiRuns).where(inArray(aiRuns.orgId, [orgId, otherOrgId]));
    await handle.db
      .delete(organizations)
      .where(inArray(organizations.id, [orgId, otherOrgId]));
    await handle.close();
  });

  it("returns every candidate the round considered, winners and losers, with `won` set", async () => {
    const result = await getMatchingRoundCandidates(handle.db, orgId, matchingRunId);
    expect(result).not.toBeNull();
    expect(result!.runId).toBe(matchingRunId);
    expect(result!.cohortId).toBe("cohort-1");
    expect(result!.candidates).toHaveLength(2);

    const winner = result!.candidates.find((c) => c.mentorId === "mentor_a")!;
    const loser = result!.candidates.find((c) => c.mentorId === "mentor_b")!;
    expect(winner.won).toBe(true);
    expect(loser.won).toBe(false);
    // The evidence an appeal needs is still there, not just the verdict.
    expect(loser.explanations["skill_fit"]).toBe("weaker fit");
    expect(loser.deterministicScore).toBe(0.5);
  });

  it("returns null for a run id that belongs to a different primitive", async () => {
    expect(await getMatchingRoundCandidates(handle.db, orgId, nonMatchingRunId)).toBeNull();
  });

  it("returns null for an unknown run id", async () => {
    expect(await getMatchingRoundCandidates(handle.db, orgId, randomUUID())).toBeNull();
  });

  it("never leaks a run across orgs, even when the id is right", async () => {
    expect(
      await getMatchingRoundCandidates(handle.db, otherOrgId, matchingRunId),
    ).toBeNull();
  });
});
