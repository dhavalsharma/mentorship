#!/usr/bin/env node
/**
 * Run the Vitest suite and fail if any test was skipped — "a skipped test is a
 * failure in CI" (docs/e2e-testing-strategy.md, "CI — the gate").
 *
 * Why this exists: every Postgres-backed suite is `describe.skipIf(!DATABASE_URL)`.
 * That is the right default on a laptop, and exactly wrong in CI — a workflow
 * that forgets DATABASE_URL, or a service container that never came up, stays
 * green while silently dropping the cross-tenant leak test and every other
 * database-backed test. Vitest's own exit code cannot see that; its JSON
 * report can.
 *
 *   node scripts/assert-no-skipped.mjs [vitest args...]
 *       Runs `vitest run` with the JSON reporter alongside the default one,
 *       then inspects the report.
 *   node scripts/assert-no-skipped.mjs --report <file.json>
 *       Inspects an existing report only (no run).
 *
 * Strict mode — any skipped/todo test is a failure, and so is a missing
 * DATABASE_URL — is on when DATABASE_URL is set, when CI is truthy (GitHub
 * Actions sets CI=true), or with --strict. Otherwise the counts are reported
 * and the exit code is Vitest's own, so running this on a laptop with no
 * Postgres behaves like `pnpm test`.
 *
 * Rejected: `--allowOnly=false`-style flags or grepping the console output.
 * Vitest has no "fail on skip" option, and the human-readable summary line is
 * not a contract; the JSON report's per-assertion `status` is.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
let strict = Boolean(process.env.DATABASE_URL) || isTruthy(process.env.CI);
let reportPath = null;
const passthrough = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--strict") strict = true;
  else if (arg === "--report") reportPath = argv[++i];
  else passthrough.push(arg);
}

let vitestStatus = 0;
if (reportPath === null) {
  reportPath = join(mkdtempSync(join(tmpdir(), "vitest-report-")), "report.json");
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...passthrough,
    ],
    { stdio: "inherit" },
  );
  if (run.error) {
    console.error(`assert-no-skipped: could not start vitest: ${run.error.message}`);
    process.exit(2);
  }
  vitestStatus = run.status ?? 1;
}

if (!existsSync(reportPath)) {
  console.error(`assert-no-skipped: no JSON report at ${reportPath}`);
  process.exit(vitestStatus || 2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const skipped = [];
let total = 0;
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    total++;
    if (test.status === "skipped" || test.status === "pending" || test.status === "todo") {
      skipped.push({ file: file.name, name: test.fullName ?? test.title, status: test.status });
    }
  }
}

console.log(
  `\nassert-no-skipped: ${total} tests, ${skipped.length} skipped` +
    ` (strict: ${strict ? "yes" : "no"}, DATABASE_URL: ${process.env.DATABASE_URL ? "set" : "unset"})`,
);

let failed = vitestStatus !== 0;

if (strict && !process.env.DATABASE_URL) {
  console.error(
    "assert-no-skipped: strict mode but DATABASE_URL is unset — every Postgres-backed suite was skipped.",
  );
  failed = true;
}

if (total === 0) {
  console.error("assert-no-skipped: the report contains no tests at all.");
  failed = true;
}

if (skipped.length > 0) {
  const byFile = new Map();
  for (const s of skipped) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
  const cwd = process.cwd() + "/";
  for (const [file, count] of byFile) {
    console.log(`  ${String(count).padStart(4)} skipped  ${file.startsWith(cwd) ? file.slice(cwd.length) : file}`);
  }
  if (strict) {
    console.error(`assert-no-skipped: ${skipped.length} skipped test(s) — a skipped test is a failure in CI.`);
    failed = true;
  }
}

process.exit(failed ? vitestStatus || 1 : 0);

function isTruthy(value) {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
