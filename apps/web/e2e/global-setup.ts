import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  API_ORIGIN,
  API_PORT,
  DATABASE_URL,
  WEB_ORIGIN,
  WEB_PORT,
  db,
  type Seed,
} from "./support";

/**
 * Seeds Postgres, then starts the two real processes a browser talks to:
 * `apps/api` (on Postgres, org A) and `next build && next start`.
 *
 * Done here rather than through Playwright's `webServer` because the servers
 * need the org id the seed generates — `webServer` starts before global setup
 * runs, so it could only ever be handed a value invented in the config file
 * — and because the api's stdout has to land somewhere a spec can read it
 * (see `readMagicLinkToken`).
 *
 * Other suites share this database concurrently, so this never truncates:
 * every row it writes is scoped to two fresh `randomUUID()` orgs, and the
 * teardown deletes exactly those orgs' rows.
 */

// Playwright loads this as CommonJS (apps/web is not `"type": "module"`), so
// `import.meta` is unavailable and `__dirname` is.
const HERE = __dirname;
const WEB_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "../..");
const ARTIFACTS = path.join(HERE, ".artifacts");

const TENANT_TABLES = [
  "risk_findings",
  "nudges",
  "saga_instances",
  "events",
  "ai_runs",
  "integration_bindings",
  "pairings",
  "audit_log",
  "identity_links",
  "participants",
  "cohorts",
  "programs",
  "magic_links",
  "auth_sessions",
  "users",
] as const;

/**
 * The smallest policy `StoredProgramPolicySchema` accepts — `consent` has no
 * default, everything else does — so the pair-preferences page can resolve
 * the program's default cadence (45 min, every 2 weeks) from it.
 */
const PREFERENCES_PROGRAM_POLICY = {
  consent: { aiProcessing: "optional", recording: "off" },
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir(ARTIFACTS, { recursive: true });
  // Otherwise `waitForHttp` would happily "find" someone else's server.
  await assertNothingListening(API_ORIGIN);
  await assertNothingListening(WEB_ORIGIN);
  const seeded = await seedDatabase();
  process.env["E2E_SEED"] = JSON.stringify(seeded);

  const children: ChildProcess[] = [];
  const teardown = async () => {
    for (const child of children) killGroup(child);
    if (process.env["E2E_KEEP_DATA"] !== "1") await deleteOrgs([seeded.orgA, seeded.orgB]);
    await db().end();
  };

  try {
    const serverEnv = {
      ...process.env,
      DATABASE_URL,
      ORG_ID: seeded.orgA,
      API_ORIGIN,
      // Dummy: nothing here signs a Slack request, but main.ts refuses to
      // boot without one.
      SLACK_SIGNING_SECRET: "e2e-not-a-real-secret",
      // Run as the RLS-bound app role, the way a deployment would, so the
      // cross-tenant spec is not quietly relying on a superuser connection.
      TENANT_ROLE: process.env["E2E_TENANT_ROLE"] ?? "mentorship_app",
    };

    children.push(
      start("api", "pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
        cwd: REPO_ROOT,
        env: { ...serverEnv, PORT: String(API_PORT) },
        logPath: seeded.apiLogPath,
      }),
    );
    await waitForHttp(API_ORIGIN, 30_000, children[0]!);

    // `rewrites()` is resolved at build time, so API_ORIGIN has to be right
    // for the build, not just for `next start`.
    if (process.env["E2E_SKIP_BUILD"] !== "1") {
      await run("pnpm", ["exec", "next", "build"], {
        cwd: WEB_DIR,
        env: serverEnv,
        logPath: path.join(ARTIFACTS, "next-build.log"),
      });
    }
    children.push(
      start("web", "pnpm", ["exec", "next", "start", "-p", String(WEB_PORT)], {
        cwd: WEB_DIR,
        env: serverEnv,
        logPath: path.join(ARTIFACTS, "web.log"),
      }),
    );
    await waitForHttp(`${WEB_ORIGIN}/login`, 60_000, children[1]!);
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}

async function seedDatabase(): Promise<Seed> {
  const sql = db();
  const tag = randomUUID().slice(0, 8);
  const orgA = randomUUID();
  const orgB = randomUUID();
  const adminEmail = `e2e-admin-${tag}@example.test`;

  await sql`insert into organizations ${sql([
    { id: orgA, name: `E2E org A ${tag}`, slug: `e2e-a-${orgA}` },
    { id: orgB, name: `E2E org B ${tag}`, slug: `e2e-b-${orgB}` },
  ])}`;
  // Both are granted `admin` directly (ADR-0010): a signed-in user with no
  // staff role is refused by every admin route, and these two are the
  // dashboard's operators. `7-invites.spec.ts` is where a non-staff session
  // earns its way in and is turned away.
  const [userA] = await sql<{ id: string }[]>`
    insert into users (org_id, email, display_name, staff_role)
    values (${orgA}, ${adminEmail}, 'E2E Admin', 'admin') returning id`;
  const [userB] = await sql<{ id: string }[]>`
    insert into users (org_id, email, display_name, staff_role)
    values (${orgB}, ${`e2e-other-${tag}@example.test`}, 'E2E Other Admin', 'admin') returning id`;

  // A program, so the document form's naming template has a policy to live
  // in (`PostgresDocumentSettingsStore.write` saves it nowhere without one).
  await sql`insert into programs (org_id, name, policy)
    values (${orgA}, 'E2E program', ${sql.json({})})`;

  const riskSummary = `E2E risk finding ${tag}`;
  const orgBRiskSummary = `E2E org B risk finding ${tag}`;
  await sql`insert into risk_findings ${sql([
    {
      org_id: orgA,
      pairing_id: randomUUID(),
      code: "e2e_no_session",
      severity: "high",
      detected_at: new Date(),
      summary: riskSummary,
      requires_human: true,
    },
    {
      org_id: orgB,
      pairing_id: randomUUID(),
      code: "e2e_no_session",
      severity: "high",
      detected_at: new Date(),
      summary: orgBRiskSummary,
      requires_human: true,
    },
  ])}`;

  const orgBFolderId = `e2eOrgBFolder${tag}`;
  await sql`insert into integration_bindings (org_id, slot, adapter_id, config)
    values (${orgB}, 'document', 'google-drive', ${sql.json({ folderId: orgBFolderId })})`;

  const nudgeBody = `E2E nudge body ${tag}`;
  await sql`insert into nudges (org_id, pairing_id, recipient_participant_id, channel, state, body, dedupe_key, sent_at)
    values (${orgA}, ${randomUUID()}, ${randomUUID()}, 'slack', 'sent', ${nudgeBody}, ${`e2e:${tag}`}, now())`;

  // Five days without progress clears the page's 3-day threshold. The timeout
  // is in the future so no worker's timer scan would ever want it.
  const stuckSubjectRef = `pairing:e2e-${tag}`;
  await sql`insert into saga_instances (org_id, saga_name, subject_ref, state, status, timeout_at, created_at, updated_at)
    values (${orgA}, 'SessionLifecycle', ${stuckSubjectRef}, ${sql.json({ name: "proposing" })},
            'running', now() + interval '30 days', now() - interval '6 days', now() - interval '5 days')`;

  const deadLetterError = `E2E dead letter ${tag}`;
  await sql`insert into events (org_id, name, subject_ref, payload, attempts, last_error, dead_lettered_at)
    values (${orgA}, 'pair.activated', ${`pairing:e2e-${tag}`}, ${sql.json({})}, 8, ${deadLetterError}, now())`;

  // One pair that changed its own length (ADR-0009): a real cohort under a
  // program with a complete policy, so the page can show the program's
  // default (45 min, every 2 weeks) beside the pair's 30 minutes. The event
  // is written directly, in the shape `PostgresPairPreferencesStore` writes,
  // and marked relayed so no worker sharing this database picks it up.
  const preferenceChangedBy = `E2E Mentee ${tag}`;
  const [prefProgram] = await sql<{ id: string }[]>`
    insert into programs (org_id, name, policy)
    values (${orgA}, 'E2E preferences program', ${sql.json(PREFERENCES_PROGRAM_POLICY)}) returning id`;
  const [prefCohort] = await sql<{ id: string }[]>`
    insert into cohorts (org_id, program_id, name, starts_at, ends_at)
    values (${orgA}, ${prefProgram!.id}, 'E2E cohort', now(), now() + interval '90 days') returning id`;
  const prefPeople = await sql<{ id: string }[]>`
    insert into users (org_id, email, display_name) values
      (${orgA}, ${`e2e-mentor-${tag}@example.test`}, ${`E2E Mentor ${tag}`}),
      (${orgA}, ${`e2e-mentee-${tag}@example.test`}, ${preferenceChangedBy})
    returning id`;
  const prefParticipants = await sql<{ id: string }[]>`
    insert into participants (org_id, cohort_id, user_id, role) values
      (${orgA}, ${prefCohort!.id}, ${prefPeople[0]!.id}, 'mentor'),
      (${orgA}, ${prefCohort!.id}, ${prefPeople[1]!.id}, 'mentee')
    returning id`;
  const [prefPairing] = await sql<{ id: string }[]>`
    insert into pairings (org_id, cohort_id, mentor_participant_id, mentee_participant_id, state, origin, pair_key, cadence_override)
    values (${orgA}, ${prefCohort!.id}, ${prefParticipants[0]!.id}, ${prefParticipants[1]!.id},
            'active', 'imported', ${`e2e-pair-${tag}`}, ${sql.json({ sessionMinutes: 30 })})
    returning id`;
  await sql`insert into events (org_id, name, subject_ref, payload, relayed_at)
    values (${orgA}, 'pair.preferences_updated', ${`pairing:${prefPairing!.id}`}, ${sql.json({
      pairingId: prefPairing!.id,
      participantId: prefParticipants[1]!.id,
      sessionMinutes: 30,
      everyDays: 14,
      changed: { sessionMinutes: 30 },
    })}, now())`;

  const matchingMenteeId = `mentee-e2e-${tag}`;
  const matchingWinnerMentorId = `mentor-win-${tag}`;
  const matchingLoserMentorId = `mentor-lose-${tag}`;
  const candidate = (mentorId: string, score: number, rank: number, rationale: string | null) => ({
    menteeId: matchingMenteeId,
    mentorId,
    eligible: true,
    violations: [],
    features: { skill_fit: score },
    explanations: { skill_fit: `skill fit ${score}` },
    deterministicScore: score,
    adjustment: 0,
    adjustedScore: score,
    rank,
    shortlisted: true,
    rationale,
    riskFlags: [],
    evidence: [],
  });
  const matchingOutput = {
    cohortId: `cohort-e2e-${tag}`,
    orgId: orgA,
    asOf: new Date().toISOString(),
    solver: "min_cost_flow",
    adjudicated: false,
    adjudicationErrors: 0,
    assignments: [
      {
        menteeId: matchingMenteeId,
        mentorId: matchingWinnerMentorId,
        score: 0.9,
        deterministicScore: 0.9,
        rank: 1,
        rationale: null,
        riskFlags: [],
      },
    ],
    unmatched: [],
    mentorLoad: [{ mentorId: matchingWinnerMentorId, assigned: 1, priorLoad: 0, capacity: 2 }],
    candidates: [
      candidate(matchingWinnerMentorId, 0.9, 1, "best available fit"),
      candidate(matchingLoserMentorId, 0.5, 2, null),
    ],
  };
  const [run] = await sql<{ id: string }[]>`
    insert into ai_runs (org_id, primitive, prompt_version, model, input_hash, output)
    values (${orgA}, 'matching.propose', 'v1', 'deterministic', ${`e2e-${tag}`}, ${sql.json(matchingOutput)})
    returning id`;

  return {
    orgA,
    userA: userA!.id,
    adminEmail,
    orgB,
    userB: userB!.id,
    riskSummary,
    orgBRiskSummary,
    orgBFolderId,
    nudgeBody,
    stuckSubjectRef,
    deadLetterError,
    preferenceChangedBy,
    matchingRunId: run!.id,
    matchingMenteeId,
    matchingWinnerMentorId,
    matchingLoserMentorId,
    apiLogPath: path.join(ARTIFACTS, `api-${tag}.log`),
  };
}

async function deleteOrgs(orgIds: string[]): Promise<void> {
  const sql = db();
  for (const table of TENANT_TABLES) {
    await sql`delete from ${sql(table)} where org_id in ${sql(orgIds)}`;
  }
  await sql`delete from organizations where id in ${sql(orgIds)}`;
}

interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}

function start(name: string, command: string, args: string[], options: ProcessOptions): ChildProcess {
  const log = createWriteStream(options.logPath);
  // Its own process group, so teardown takes pnpm *and* the node it spawned.
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] ${name} exited with ${code} — see ${options.logPath}`);
    }
  });
  return child;
}

function run(command: string, args: string[], options: ProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = start(`${command} ${args.join(" ")}`, command, args, options);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} failed (${code}) — see ${options.logPath}`)),
    );
  });
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function assertNothingListening(origin: string): Promise<void> {
  try {
    await fetch(origin);
  } catch {
    return;
  }
  throw new Error(
    `${origin} is already in use — stop it, or pick other ports with E2E_API_PORT / E2E_WEB_PORT`,
  );
}

async function waitForHttp(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`process for ${url} exited early`);
    try {
      await fetch(url);
      return; // any HTTP response at all means it is listening
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}
