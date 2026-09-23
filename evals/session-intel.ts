import { and, eq } from "drizzle-orm";
import { runPrimitive } from "@mentorship/ai";
import { defaultPolicy, type LlmProvider } from "@mentorship/core";
import { aiRuns, withoutTenantIsolation, withTenant, type Db } from "@mentorship/db";
import {
  aggregateActionItemScores,
  anchoredSpanValidity,
  createSessionIntelPrimitive,
  PROMPT_REF,
  ratio,
  scoreActionItems,
  scoreSafeguarding,
  SESSION_INTEL_PRIMITIVE,
  type AiRunRow,
  type FieldScore,
  type GoldenCase,
  type Ratio,
  type SafeguardingScore,
  type SessionIntelOutput,
} from "@mentorship/primitive-session-intel";
import { pairFixture } from "../packages/primitives/session-intel/src/__tests__/fixtures.js";
import { GOLDEN_CASES } from "../packages/primitives/session-intel/src/__tests__/golden-fixtures.js";
import {
  SAFEGUARDING_CASES,
  type SafeguardingCase,
} from "../packages/primitives/session-intel/src/__tests__/safeguarding-fixtures.js";

/**
 * The session-intel eval (tier 5): golden set, hand-labelled safeguarding
 * set, and — when a database is reachable — every `ai_runs` row a human has
 * put a Confirm/Edit verdict on. Measures; never gates.
 *
 * Every labelled case runs through `runPrimitive` with the real
 * `createSessionIntelPrimitive`, exactly as the worker does, so a case scored
 * here took the same path (consent check, repair retry, evidence
 * verification, fallback) a production extraction takes.
 */

export interface GoldenResult {
  name: string;
  degraded: boolean;
  score: FieldScore;
  spans: Ratio;
}

export interface LabelledReport {
  promptVersion: string;
  model: string;
  golden: {
    cases: GoldenResult[];
    actionItems: FieldScore;
    spans: Ratio;
    degraded: number;
  };
  safeguarding: SafeguardingScore & { spans: Ratio; degraded: number };
}

async function extract(llm: LlmProvider, source: string): Promise<{ output: SessionIntelOutput; degraded: boolean }> {
  const pair = pairFixture();
  const run = await runPrimitive({
    primitive: createSessionIntelPrimitive(),
    trigger: {
      sessionId: "eval",
      pairingId: pair.pairingId,
      sourceRef: "transcript:eval",
      sourceKind: "transcript",
      text: source,
    },
    reader: {
      pairContext: async () => pair,
      goals: async () => [{ goalRef: "goal_1", title: "promotion packet" }],
    },
    llm,
    policy: defaultPolicy({}),
    orgId: pair.orgId,
  });
  return { output: run.output, degraded: run.degraded };
}

function sumRatios(rs: Ratio[]): Ratio {
  return ratio(
    rs.reduce((n, r) => n + r.num, 0),
    rs.reduce((n, r) => n + r.den, 0),
  );
}

export async function runLabelledEval(
  llm: LlmProvider,
  sets: { golden?: GoldenCase[]; safeguarding?: SafeguardingCase[] } = {},
): Promise<LabelledReport> {
  const golden = sets.golden ?? GOLDEN_CASES;
  const safeguarding = sets.safeguarding ?? SAFEGUARDING_CASES;

  const goldenRuns = [];
  for (const g of golden) {
    const { output, degraded } = await extract(llm, g.source);
    goldenRuns.push({ g, output, degraded });
  }
  const cases: GoldenResult[] = goldenRuns.map(({ g, output, degraded }) => ({
    name: g.name,
    degraded,
    score: scoreActionItems(g.expectedActionItems, output.actionItems),
    spans: anchoredSpanValidity(g.source, output),
  }));

  const sgRuns = [];
  for (const c of safeguarding) {
    const { output, degraded } = await extract(llm, c.source);
    sgRuns.push({ c, output, degraded });
  }

  return {
    promptVersion: PROMPT_REF,
    model: llm.model,
    golden: {
      cases,
      actionItems: aggregateActionItemScores(
        goldenRuns.map(({ g, output }) => ({ expected: g.expectedActionItems, actual: output.actionItems })),
      ),
      spans: sumRatios(cases.map((c) => c.spans)),
      degraded: cases.filter((c) => c.degraded).length,
    },
    safeguarding: {
      ...scoreSafeguarding(
        sgRuns.map(({ c, output }) => ({
          name: c.name,
          expected: c.safeguarding,
          predicted: output.riskFlags.includes("safeguarding"),
        })),
      ),
      spans: sumRatios(sgRuns.map(({ c, output }) => anchoredSpanValidity(c.source, output))),
      degraded: sgRuns.filter((r) => r.degraded).length,
    },
  };
}

/**
 * One tenant at a time, inside `withTenant` (invariant 3). With no org named,
 * the org ids themselves are listed across tenants — the one cross-tenant
 * read, of ids only, the same door the relay uses — and each org's rows are
 * then read under its own scope. Only aggregates ever leave this function.
 */
export async function readSessionIntelRuns(
  db: Db,
  options: { orgIds?: string[]; role?: string } = {},
): Promise<{ orgs: number; rows: AiRunRow[] }> {
  const orgIds =
    options.orgIds ??
    (await withoutTenantIsolation(db, async (tx) => {
      const found = await tx
        .selectDistinct({ orgId: aiRuns.orgId })
        .from(aiRuns)
        .where(eq(aiRuns.primitive, SESSION_INTEL_PRIMITIVE));
      return found.map((r) => r.orgId);
    }));

  const rows: AiRunRow[] = [];
  for (const orgId of orgIds) {
    const found = await withTenant(
      db,
      orgId,
      (tx) =>
        tx
          .select({
            promptVersion: aiRuns.promptVersion,
            model: aiRuns.model,
            verdict: aiRuns.verdict,
            error: aiRuns.error,
            output: aiRuns.output,
            input: aiRuns.input,
          })
          .from(aiRuns)
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.primitive, SESSION_INTEL_PRIMITIVE))),
      options.role === undefined ? {} : { role: options.role },
    );
    rows.push(...found);
  }
  return { orgs: orgIds.length, rows };
}
