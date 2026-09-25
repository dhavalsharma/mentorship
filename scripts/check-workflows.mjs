#!/usr/bin/env node
/**
 * Static checks over .github/ — the class of mistake that only shows up as a
 * red run on GitHub, hours later, because nothing local ever executes the YAML.
 *
 *   node scripts/check-workflows.mjs [repo-root]
 *
 * What it checks:
 *   1. Every .github/workflows/*.yml and .github/actions/*\/action.yml parses.
 *   2. A job that needs Postgres — `DATABASE_URL` in the workflow, job or step
 *      env, or a step that runs `db:migrate` — declares `services.db`.
 *      (The nightly `eval` job set DATABASE_URL and ran db:migrate with no
 *      service, and would have failed on connection refused every night.)
 *   3. Every `services.db` is identical to the one in ci.yml's `gate` job —
 *      image, env, ports, health check. A drifted copy (another pg major, a
 *      missing pgvector, no health check so migrate races the container) is
 *      the same bug one step removed.
 *   4. The reverse: a job with `services.db` but no DATABASE_URL is starting a
 *      container nothing uses — usually a job whose env was lost in an edit.
 *   5. A composite action never references DATABASE_URL: composite actions
 *      cannot declare services, so whatever job uses one has to.
 *
 * Rejected: factoring the service into a YAML anchor. GitHub's anchor support
 * is recent, and every copy here is plain YAML any tool reads; rule 3 keeps
 * the copies honest instead.
 *
 * js-yaml is a root devDependency for this script (it was only transitive
 * before, via eslint and cosmiconfig, and so not importable from the root).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";

const root = resolve(process.argv[2] ?? ".");
const errors = [];
const fail = (file, msg) => errors.push(`${relative(root, file)}: ${msg}`);

function load(file) {
  try {
    return yaml.load(readFileSync(file, "utf8"));
  } catch (err) {
    fail(file, `does not parse — ${err.message.split("\n")[0]}`);
    return undefined;
  }
}

const mentionsDbUrl = (env) =>
  env != null && typeof env === "object" && Object.hasOwn(env, "DATABASE_URL");

const workflowsDir = join(root, ".github/workflows");
const workflowFiles = existsSync(workflowsDir)
  ? readdirSync(workflowsDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => join(workflowsDir, f))
  : [];

const workflows = new Map(workflowFiles.map((f) => [f, load(f)]));

const ciFile = join(workflowsDir, "ci.yml");
const canonicalDb = workflows.get(ciFile)?.jobs?.gate?.services?.db;
if (!canonicalDb) fail(ciFile, "jobs.gate.services.db is missing — it is the reference every other db service is compared against");

for (const [file, wf] of workflows) {
  if (!wf) continue;
  if (typeof wf.jobs !== "object" || wf.jobs === null) {
    fail(file, "has no jobs");
    continue;
  }
  for (const [id, job] of Object.entries(wf.jobs)) {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const needsDb =
      mentionsDbUrl(wf.env) ||
      mentionsDbUrl(job.env) ||
      steps.some((s) => mentionsDbUrl(s.env) || /\bdb:migrate\b/.test(s.run ?? ""));
    const db = job.services?.db;

    if (needsDb && !db) {
      fail(file, `job "${id}" uses DATABASE_URL or db:migrate but declares no services.db`);
    }
    if (db && canonicalDb && !isDeepStrictEqual(db, canonicalDb)) {
      fail(file, `job "${id}" services.db differs from ci.yml's gate job — keep image, env, ports and health check identical`);
    }
    if (db && !needsDb) {
      fail(file, `job "${id}" starts services.db but never sets DATABASE_URL`);
    }
  }
}

const actionsDir = join(root, ".github/actions");
if (existsSync(actionsDir)) {
  for (const name of readdirSync(actionsDir)) {
    for (const f of ["action.yml", "action.yaml"]) {
      const file = join(actionsDir, name, f);
      if (!existsSync(file)) continue;
      const action = load(file);
      if (action && /DATABASE_URL/.test(JSON.stringify(action))) {
        fail(file, "a composite action cannot declare services; set DATABASE_URL (and services.db) on the job instead");
      }
    }
  }
}

if (workflowFiles.length === 0) fail(workflowsDir, "no workflow files found");

if (errors.length > 0) {
  console.error(`check-workflows: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`check-workflows: ${workflowFiles.length} workflow(s) OK`);
