import { writeFileSync } from "node:fs";
import { AnthropicProvider, DeterministicProvider } from "@mentorship/ai";
import type { LlmProvider } from "@mentorship/core";
import { createClient } from "@mentorship/db";
import {
  formatRatio,
  summarizeAiRuns,
  type VerdictGroup,
} from "@mentorship/primitive-session-intel";
import { readSessionIntelRuns, runLabelledEval, type LabelledReport } from "./session-intel.js";

/**
 * `pnpm eval` — tier 5 of docs/e2e-testing-strategy.md.
 *
 * Measures session intelligence against labels and prints the rates. It is
 * not a test and never gates anything: it exits 0 whatever the scores are,
 * and non-zero only when the harness itself could not run (a bad fixture, an
 * unreachable DATABASE_URL). A prompt change that moves a number is a
 * conversation, not a red build.
 *
 *   - Without ANTHROPIC_API_KEY (the default, and the only mode this repo's
 *     own checks ever use) every extraction is the deterministic fallback, and
 *     the output says so up front.
 *   - With ANTHROPIC_API_KEY it uses the real provider — it costs money and
 *     it is nondeterministic. `EVAL_MODEL` picks the model.
 *   - With DATABASE_URL it also reads `ai_runs` rows carrying a human
 *     Confirm/Edit verdict, one tenant at a time (`EVAL_ORG_ID` to pick one;
 *     all orgs with session-intel runs otherwise). Only aggregates print.
 *   - `EVAL_REPORT_PATH` also writes the whole report as JSON, for trending.
 */

function provider(): { llm: LlmProvider; mode: "anthropic" | "deterministic" } {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key) {
    const model = process.env["EVAL_MODEL"];
    return { llm: new AnthropicProvider({ apiKey: key, ...(model ? { model } : {}) }), mode: "anthropic" };
  }
  // Fails every call, on purpose: `runPrimitive` then takes the same fallback
  // path a production outage takes, so what is scored is exactly what a
  // tenant with no model configured gets.
  return {
    llm: new DeterministicProvider({
      model: "deterministic-fallback",
      failWith: new Error("pnpm eval: no ANTHROPIC_API_KEY, scoring the deterministic fallback"),
    }),
    mode: "deterministic",
  };
}

function printLabelled(report: LabelledReport, mode: string): void {
  const header = `prompt_version ${report.promptVersion} · model ${report.model}`;
  console.log(`\n== labelled sets · ${header}`);

  const g = report.golden;
  console.log(`\n-- golden set (${g.cases.length} cases, action items; ${g.degraded} via fallback)`);
  for (const c of g.cases) {
    console.log(
      `  ${c.name.padEnd(58)} P ${c.score.precision.toFixed(2)}  R ${c.score.recall.toFixed(2)}  spans ${formatRatio(c.spans)}`,
    );
  }
  console.log(
    `  aggregate (micro): precision ${g.actionItems.precision.toFixed(2)}  recall ${g.actionItems.recall.toFixed(2)}`,
  );
  console.log(`  evidence spans anchored in the unedited source (inv. 18): ${formatRatio(g.spans)}`);

  const s = report.safeguarding;
  console.log(
    `\n-- safeguarding set (${s.tp + s.fp + s.fn + s.tn} cases, ${s.tp + s.fn} labelled positive; ${s.degraded} via fallback)`,
  );
  console.log(`  recall    ${formatRatio(s.recall)}`);
  console.log(`  precision ${formatRatio(s.precision)}`);
  console.log(`  tp ${s.tp}  fp ${s.fp}  fn ${s.fn}  tn ${s.tn}`);
  if (s.missed.length > 0) console.log(`  missed: ${s.missed.join("; ")}`);
  if (s.falseAlarms.length > 0) console.log(`  false alarms: ${s.falseAlarms.join("; ")}`);
  console.log(`  evidence spans anchored: ${formatRatio(s.spans)}`);
  if (mode === "deterministic") {
    console.log(
      "  note: the fallback never raises a risk flag, by design (invariant 16; fallback.ts) —\n" +
        "        recall 0 here is the honest number for a tenant with no model, not a regression.",
    );
  }
}

function printStored(groups: VerdictGroup[], orgs: number): void {
  const runs = groups.reduce((n, g) => n + g.runs, 0);
  console.log(`\n== ai_runs (session.intel) · ${runs} run(s) across ${orgs} org(s), grouped by prompt_version`);
  if (groups.length === 0) {
    console.log("  none yet — every Confirm/Edit tap in Slack becomes a label here (invariant 19).");
    return;
  }
  for (const g of groups) {
    console.log(`\n-- ${g.promptVersion} · ${g.model}`);
    console.log(
      `  runs ${g.runs}  degraded ${g.degraded}  confirmed ${g.confirmed}  edited ${g.edited}  unlabelled ${g.unlabelled}`,
    );
    console.log(`  accepted as-is (confirm / labelled): ${formatRatio(g.acceptedAsIs)}`);
    console.log(`  evidence spans, structurally consistent: ${formatRatio(g.structuralSpans)}`);
    console.log(
      g.unanchorableSpans > 0
        ? `  evidence spans, anchored: ${formatRatio(g.anchoredSpans)} — ${g.unanchorableSpans} span(s) unanchorable: ai_runs.input does not record the source`
        : `  evidence spans, anchored: ${formatRatio(g.anchoredSpans)}`,
    );
    console.log(`  safeguarding flagged: ${g.safeguardingFlagged} (no labels to score recall against)`);
  }
}

async function main(): Promise<void> {
  const { llm, mode } = provider();
  console.log("pnpm eval — session intelligence. Measures, never gates: exit 0 whatever the scores.");
  console.log(
    mode === "deterministic"
      ? "mode: DETERMINISTIC — no ANTHROPIC_API_KEY, so every extraction below is the deterministic\n" +
          "      fallback (fallbackExtraction via runPrimitive's degrade path), not a model."
      : `mode: LIVE MODEL — ${llm.model}. Costs money and is nondeterministic; compare trends, not runs.`,
  );

  const labelled = await runLabelledEval(llm);
  printLabelled(labelled, mode);

  let stored: { orgs: number; groups: VerdictGroup[] } | { skipped: string } = {
    skipped: "DATABASE_URL not set",
  };
  const url = process.env["DATABASE_URL"];
  if (url) {
    const { db, sqlClient } = createClient(url);
    try {
      const orgId = process.env["EVAL_ORG_ID"];
      const { orgs, rows } = await readSessionIntelRuns(db, orgId ? { orgIds: [orgId] } : {});
      const groups = summarizeAiRuns(rows);
      printStored(groups, orgs);
      stored = { orgs, groups };
    } finally {
      await sqlClient.end();
    }
  } else {
    console.log("\n== ai_runs: skipped (DATABASE_URL not set)");
  }

  const reportPath = process.env["EVAL_REPORT_PATH"];
  if (reportPath) {
    writeFileSync(
      reportPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), mode, labelled, stored }, null, 2)}\n`,
    );
    console.log(`\nreport written to ${reportPath}`);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("pnpm eval: harness error —", error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  },
);
