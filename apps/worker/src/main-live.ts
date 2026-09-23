import { AnthropicProvider } from "@mentorship/ai";
import { PostgresAiRunSink } from "@mentorship/ai/postgres";
import { createClient } from "@mentorship/db";
import { buildLiveRegistry } from "./live-registry.js";
import { resolveDocumentConfig } from "./document-config.js";
import { resolveSheetConfig } from "./reports.js";
import { createWorker } from "./worker.js";

/**
 * Same loop as `main.ts`, real adapters. Kept as a separate entrypoint rather
 * than a flag on the default one, so pointing this at an actual workspace is
 * always something you typed on purpose — see docs/live-tenant-testing.md
 * before running it.
 *
 * The `↳` detail lines only come from `Recorder`, which the real Slack and
 * Google adapters do not use — they call the actual APIs. What a live pass
 * did is visible in the trace's `effects:` list and in Slack/Google
 * themselves; the `↳` lines here only ever cover the fake transcript and
 * document slots.
 *
 * Run with: pnpm serve:worker:live
 */

const DATABASE_URL = process.env["DATABASE_URL"];
const ORG_ID = process.env["ORG_ID"];
const INTERVAL_MS = Number(process.env["WORKER_INTERVAL_MS"] ?? 1000);
const TENANT_ROLE = process.env["TENANT_ROLE"];

if (!DATABASE_URL || !ORG_ID) {
  console.error("DATABASE_URL and ORG_ID are both required — pnpm seed:live-pair prints an ORG_ID");
  process.exit(1);
}

const { db, sqlClient } = createClient(DATABASE_URL);

const document = await resolveDocumentConfig(db, ORG_ID, process.env, TENANT_ROLE);
const sheet = await resolveSheetConfig(db, ORG_ID, process.env, TENANT_ROLE);
// Hourly, matching main.ts's default — a report tab is checked in on
// periodically, not something that needs sub-minute freshness.
const REPORT_SYNC_INTERVAL_MS = Number(process.env["REPORT_SYNC_INTERVAL_MS"] ?? 60 * 60_000);

let registry: ReturnType<typeof buildLiveRegistry>["registry"];
let recorder: ReturnType<typeof buildLiveRegistry>["recorder"];
try {
  ({ registry, recorder } = buildLiveRegistry(
    process.env,
    (detail) =>
      console.warn(`[sandbox] refused ${detail.adapter}: ${detail.refused.join(", ")}`),
    document.config,
    sheet.config,
  ));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const scopedRole = TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE };
const llm = process.env["ANTHROPIC_API_KEY"] ? new AnthropicProvider() : undefined;
const runs = llm ? new PostgresAiRunSink(db, scopedRole) : undefined;

const worker = createWorker({
  db,
  orgId: ORG_ID,
  registry,
  ...(TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE }),
  // The same resolved config the Drive adapter above was built from, reused
  // rather than re-derived: the messages' playbook link and the running doc's
  // seed must be the same answer to the same question. Resolving it twice is
  // exactly how an env-configured org ended up with a seeded doc and no link.
  ...(document.config?.guidelineDocId
    ? { documentConfigFallback: { guidelineDocId: document.config.guidelineDocId } }
    : {}),
  ...(llm ? { llm, ...(runs ? { runs } : {}) } : {}),
  onWarn: (message, detail) => console.warn(`[warn] ${message}`, detail ?? ""),
  onTrace: (line) =>
    console.log(
      `  ${line.input.padEnd(20)} ${line.from} → ${line.to}` +
        (line.effects.length > 0 ? `  effects: ${line.effects.join(", ")}` : ""),
    ),
  ...(REPORT_SYNC_INTERVAL_MS > 0
    ? { schedules: { reportSync: { intervalMs: REPORT_SYNC_INTERVAL_MS } } }
    : {}),
  reportSyncEnv: {
    GOOGLE_SHEETS_FOLDER_ID: process.env["GOOGLE_SHEETS_FOLDER_ID"],
    GOOGLE_SHEETS_SPREADSHEET_ID: process.env["GOOGLE_SHEETS_SPREADSHEET_ID"],
  },
});

console.log(`LIVE worker started for org ${ORG_ID}, polling every ${INTERVAL_MS}ms`);
console.log(
  "adapters: real Slack + Google, guarded by SandboxGuard — transcript is " +
    "still a fake, because no real adapter for it exists yet",
);
console.log(
  document.config
    ? `document: real Google Drive, folder ${document.config.folderId} (from ${document.source})` +
        (document.config.guidelineDocId
          ? `, seeded from doc ${document.config.guidelineDocId}`
          : ", starting blank")
    : "document: fake (no integration_bindings row and no GOOGLE_DRIVE_FOLDER_ID)",
);
console.log(
  sheet.config
    ? `sheet: real Google Sheets, folder ${sheet.config.folderId} (from ${sheet.source})`
    : "sheet: fake (no integration_bindings row and no GOOGLE_SHEETS_FOLDER_ID)",
);
console.log(
  llm
    ? `session intelligence: ${llm.model}, ai_runs recorded\n`
    : "session intelligence: deterministic stub (set ANTHROPIC_API_KEY to use the real primitive)\n",
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
    const { relay, timers, tick } = await worker.pass();
    if (relay.delivered > 0 || timers > 0 || relay.failed > 0) {
      console.log(
        `pass: ${relay.delivered} delivered, ${timers} timers` +
          (relay.failed > 0 ? `, ${relay.failed} failed` : "") +
          (relay.deadLettered > 0 ? `, ${relay.deadLettered} parked` : "") +
          (tick.failed > 0 ? `, ${tick.failed} timer steps failed` : "") +
          (tick.parked > 0 ? `, ${tick.parked} sagas parked` : ""),
      );
    }
    for (const call of recorder.calls.slice(seen)) {
      console.log(`    ↳ ${call.kind}`);
    }
    seen = recorder.calls.length;
  } catch (error) {
    console.error("[pass failed]", error instanceof Error ? error.message : error);
  }
  await sleep(INTERVAL_MS, controller.signal);
}

await sqlClient.end();
console.log("stopped");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
