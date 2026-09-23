import { AnthropicProvider } from "@mentorship/ai";
import { PostgresAiRunSink } from "@mentorship/ai/postgres";
import { createClient } from "@mentorship/db";
import {
  FakeCalendar,
  FakeConversation,
  FakeDm,
  FakeDocument,
  FakeSheet,
  FakeTranscript,
  IntegrationRegistry,
  Recorder,
} from "@mentorship/integrations";
import { createWorker } from "./worker.js";

/**
 * The worker process: drain the outbox, fire due timers, repeat.
 *
 * No pg-boss, despite ADR-0008 naming it. pg-boss earns its place for
 * scheduled and cron-shaped work — the temporal sweep, when that exists — and
 * its other headline feature is making sure only one worker runs a job. This
 * loop does not need that: the relay claims rows with SKIP LOCKED and the
 * engine saves with `WHERE version = $expected`, so two workers polling the
 * same database is already safe, and a distributed lock would only add a way
 * for the whole thing to stop when the lock holder wedges.
 *
 * The adapters are the fakes. Slack and Google exist but have never run
 * against a live tenant, so binding them here would dress up an untested path
 * as a working one. Swapping them is the whole of what `IntegrationRegistry`
 * is for.
 *
 * Run with: pnpm serve:worker
 */

const DATABASE_URL = process.env["DATABASE_URL"];
const ORG_ID = process.env["ORG_ID"];
const INTERVAL_MS = Number(process.env["WORKER_INTERVAL_MS"] ?? 1000);
const TENANT_ROLE = process.env["TENANT_ROLE"];

// Periodic sweeps, each independently configurable and each off by passing
// 0 or a negative number — matching the "off unless configured" default
// `WorkerOptions.schedules` documents. Defaults are minutes-scale on purpose:
// these are about absence and drift, not anything that needs the relay's
// sub-second responsiveness.
const NUDGE_SWEEP_INTERVAL_MS = Number(process.env["NUDGE_SWEEP_INTERVAL_MS"] ?? 15 * 60_000);
const PROGRESS_SWEEP_INTERVAL_MS = Number(process.env["PROGRESS_SWEEP_INTERVAL_MS"] ?? 15 * 60_000);
const DIGEST_INTERVAL_MS = Number(process.env["DIGEST_INTERVAL_MS"] ?? 60 * 60_000);
// A report tab is for a human to check in on periodically, not something
// that needs sub-minute freshness, so this defaults to the same hourly
// cadence as the digest rather than the 15-minute nudge/progress sweeps.
const REPORT_SYNC_INTERVAL_MS = Number(process.env["REPORT_SYNC_INTERVAL_MS"] ?? 60 * 60_000);
// Entitlements change when an admin changes a setting, and nothing tells us
// (ADR-0006). Six hours: a probe is a vendor call per slot, and a stale
// answer degrades a proposal rather than breaking one.
const CAPABILITY_PROBE_INTERVAL_MS = Number(
  process.env["CAPABILITY_PROBE_INTERVAL_MS"] ?? 6 * 60 * 60_000,
);

if (!DATABASE_URL || !ORG_ID) {
  console.error("DATABASE_URL and ORG_ID are both required");
  process.exit(1);
}

const { db, sqlClient } = createClient(DATABASE_URL);

const recorder = new Recorder();
const registry = new IntegrationRegistry();
registry.bind(new FakeConversation(recorder));
registry.bind(new FakeDm(recorder));
registry.bind(new FakeCalendar(recorder, {}));
registry.bind(new FakeTranscript(recorder, { autoTranscription: "native" }));
registry.bind(new FakeDocument(recorder));
registry.bind(new FakeSheet(recorder));

// Session intelligence runs for real once a key is present; otherwise the
// deterministic stub keeps the worker usable with no external dependency at
// all. Opt-in, not auto-detected from some other setting, so pointing a
// worker at a real model is always something an operator typed on purpose.
const scopedRole = TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE };
const llm = process.env["ANTHROPIC_API_KEY"] ? new AnthropicProvider() : undefined;
const runs = llm ? new PostgresAiRunSink(db, scopedRole) : undefined;

const worker = createWorker({
  db,
  orgId: ORG_ID,
  registry,
  ...(TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE }),
  ...(llm ? { llm, ...(runs ? { runs } : {}) } : {}),
  onWarn: (message, detail) => console.warn(`[warn] ${message}`, detail ?? ""),
  onTrace: (line) =>
    console.log(
      `  ${line.input.padEnd(20)} ${line.from} → ${line.to}` +
        (line.effects.length > 0 ? `  effects: ${line.effects.join(", ")}` : ""),
    ),
  schedules: {
    ...(NUDGE_SWEEP_INTERVAL_MS > 0 ? { nudge: { intervalMs: NUDGE_SWEEP_INTERVAL_MS } } : {}),
    ...(PROGRESS_SWEEP_INTERVAL_MS > 0 ? { progress: { intervalMs: PROGRESS_SWEEP_INTERVAL_MS } } : {}),
    ...(DIGEST_INTERVAL_MS > 0 ? { digest: { intervalMs: DIGEST_INTERVAL_MS } } : {}),
    ...(REPORT_SYNC_INTERVAL_MS > 0 ? { reportSync: { intervalMs: REPORT_SYNC_INTERVAL_MS } } : {}),
    ...(CAPABILITY_PROBE_INTERVAL_MS > 0
      ? { capabilityProbe: { intervalMs: CAPABILITY_PROBE_INTERVAL_MS } }
      : {}),
  },
  reportSyncEnv: {
    GOOGLE_SHEETS_FOLDER_ID: process.env["GOOGLE_SHEETS_FOLDER_ID"],
    GOOGLE_SHEETS_SPREADSHEET_ID: process.env["GOOGLE_SHEETS_SPREADSHEET_ID"],
  },
});

// Boot is connect time (ADR-0006): these adapters are fixed for the life of
// the process, so ask them once now, before the first pass reads the cache.
// A failing probe is warned about and recorded, not fatal.
const probe = await worker.probeCapabilities();
console.log(
  "capabilities probed: " +
    probe.probed.map((r) => `${r.slot}${r.ok ? "" : " (FAILED)"}`).join(", ") +
    (probe.cleared.length > 0 ? `; cleared unbound: ${probe.cleared.join(", ")}` : ""),
);

console.log(`worker started for org ${ORG_ID}, polling every ${INTERVAL_MS}ms`);
console.log("adapters: fakes — Slack and Google have never run live");
console.log(
  llm
    ? `session intelligence: ${llm.model}, ai_runs recorded\n`
    : "session intelligence: deterministic stub (set ANTHROPIC_API_KEY to use the real primitive)\n",
);
console.log(
  `sweeps: nudge ${NUDGE_SWEEP_INTERVAL_MS > 0 ? `every ${NUDGE_SWEEP_INTERVAL_MS}ms` : "off"}, ` +
    `progress ${PROGRESS_SWEEP_INTERVAL_MS > 0 ? `every ${PROGRESS_SWEEP_INTERVAL_MS}ms` : "off"}, ` +
    `digest ${DIGEST_INTERVAL_MS > 0 ? `every ${DIGEST_INTERVAL_MS}ms` : "off"}, ` +
    `report-sync ${REPORT_SYNC_INTERVAL_MS > 0 ? `every ${REPORT_SYNC_INTERVAL_MS}ms` : "off"}\n`,
);

const controller = new AbortController();
let draining = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (draining) process.exit(1);
    draining = true;
    console.log(`\n${signal} — finishing the pass in flight, then stopping`);
    controller.abort();
  });
}

let seen = 0;
while (!controller.signal.aborted) {
  try {
    const { relay, timers } = await worker.pass();
    if (relay.delivered > 0 || timers > 0 || relay.failed > 0) {
      console.log(
        `pass: ${relay.delivered} delivered, ${timers} timers` +
          (relay.failed > 0 ? `, ${relay.failed} failed` : "") +
          (relay.deadLettered > 0 ? `, ${relay.deadLettered} parked` : ""),
      );
    }
    const { ran } = await worker.sweep();
    if (ran.length > 0) console.log(`sweep: ${ran.join(", ")}`);
    for (const call of recorder.calls.slice(seen)) {
      console.log(`    ↳ ${call.kind}`);
    }
    seen = recorder.calls.length;
  } catch (error) {
    // A pass that throws is a bug or an outage; either way the next one may
    // well succeed, and a worker that exits on the first blip is worse than
    // one that keeps trying and says so.
    console.error("[pass failed]", error instanceof Error ? error.message : error);
  }
  await sleep(INTERVAL_MS, controller.signal);
}

await sqlClient.end();
console.log("stopped");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // The listener has to be removed when the timer wins, not just when the
    // abort fires: `once` only cleans up on dispatch, so in a loop that mostly
    // times out they accumulate one per pass until Node warns about a leak.
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
