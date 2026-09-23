import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeterministicProvider } from "@mentorship/ai";
import { PostgresAiRunSink } from "@mentorship/ai/postgres";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  PROMPT_REF,
  SESSION_INTEL_PRIMITIVE,
  summarizeAiRuns,
} from "@mentorship/primitive-session-intel";
import { readSessionIntelRuns, runLabelledEval } from "../session-intel.js";

/**
 * The eval harness, not the eval: `pnpm eval` itself never runs in the gate
 * (it measures, it is not a pass/fail), but whether it can read what it
 * claims to read is deterministic and belongs here.
 */

describe("runLabelledEval, deterministic mode", () => {
  it("scores the fallback: every span anchored, and no safeguarding detection by design", async () => {
    const report = await runLabelledEval(
      new DeterministicProvider({ model: "deterministic-fallback", failWith: new Error("no key") }),
    );

    expect(report.promptVersion).toBe(PROMPT_REF);
    expect(report.golden.degraded).toBe(report.golden.cases.length);
    // Invariant 18, end to end: the fallback's spans all index the source.
    expect(report.golden.spans.value).toBe(1);
    // Invariant 16: the fallback never flags. Recall is zero, precision has
    // nothing to be measured over — the honest reading of a model-less tenant.
    expect(report.safeguarding.tp + report.safeguarding.fp).toBe(0);
    expect(report.safeguarding.recall.value).toBe(0);
    expect(report.safeguarding.precision.value).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)("readSessionIntelRuns (Postgres)", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();

  beforeAll(async () => {
    handle = await connectTestDb();
    const sink = new PostgresAiRunSink(handle.db);
    const output = {
      summary: [],
      actionItems: [
        { owner: "part_mentor", text: "x", dueHint: null, evidence: { start: 0, end: 4, quote: "Sam:" } },
      ],
      goalProgress: [],
      blockers: [],
      sentimentBand: "neutral",
      riskFlags: [],
      nextSessionPrep: [],
    };
    for (const [i, verdict] of (["confirm", "edit", null] as const).entries()) {
      await sink.record({
        orgId,
        primitive: SESSION_INTEL_PRIMITIVE,
        promptVersion: "session.intel@eval-test",
        model: "m",
        inputHash: `h${i}`,
        output,
        subjectId: `ext_${i}`,
      });
      if (verdict) await sink.setVerdict({ orgId, subjectId: `ext_${i}`, verdict });
    }
    await sink.record({
      orgId: otherOrgId,
      primitive: SESSION_INTEL_PRIMITIVE,
      promptVersion: "session.intel@eval-test",
      model: "m",
      inputHash: "other",
      subjectId: "ext_other",
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it("reads one tenant's runs under RLS and summarises the human verdicts", async () => {
    const { orgs, rows } = await readSessionIntelRuns(handle.db, {
      orgIds: [orgId],
      role: "mentorship_app",
    });
    expect(orgs).toBe(1);
    expect(rows).toHaveLength(3);
    const [group] = summarizeAiRuns(rows);
    expect(group).toMatchObject({ runs: 3, confirmed: 1, edited: 1, unlabelled: 1 });
    expect(group!.acceptedAsIs.value).toBe(0.5);
    // ai_runs does not record the source, so spans are unanchorable — said, not hidden.
    expect(group!.unanchorableSpans).toBe(3);
  });

  it("finds every org with runs when none is named, still reading each under its own scope", async () => {
    const { rows } = await readSessionIntelRuns(handle.db);
    const mine = rows.filter((r) => r.promptVersion === "session.intel@eval-test");
    expect(mine.length).toBeGreaterThanOrEqual(4);
  });
});
