import { bareUuidIds, type IdFactory, type LlmProvider } from "@mentorship/core";
import type { Db } from "@mentorship/db";
import type { AiRunSink } from "@mentorship/ai";
import type { IntegrationRegistry } from "@mentorship/integrations";
import { createPrimitiveSessionIntel } from "@mentorship/primitive-session-intel";
import {
  createEffectRunner,
  createSessionLifecycle,
  heuristicSessionIntel,
  SagaEngine,
  SESSION_LIFECYCLE,
  type SessionIntel,
  type TickResult,
  type TraceLine,
} from "@mentorship/workflows";
import {
  PostgresEventSink,
  PostgresProjector,
  PostgresSagaResolvers,
  PostgresSagaStore,
  PostgresSessionSourceStore,
  probeAndCacheCapabilities,
  relayOnce,
  type ProbeCapabilitiesResult,
  type DocumentConfigFallback,
  type RelayResult,
} from "@mentorship/workflows/postgres";
import { runDigestSweep, type DigestSummary } from "./digest.js";
import { createReportSyncRunner, type SheetEnv, type SyncReportsResult } from "./reports.js";
import { Scheduler, type SchedulerTickResult, type SweepJob } from "./scheduler.js";
import { createNudgeSweepRunner, createProgressSweepRunner } from "./sweeps.js";

/**
 * The Postgres path, assembled: store, resolvers, sink, engine and relay.
 *
 * Every piece was already tested on its own; what this adds is the wiring and
 * the loop. A pass drains the outbox and then fires due timers, in that order,
 * because an event usually sets the timer that the tick is looking for and
 * doing it the other way round just costs a cycle.
 *
 * `bareUuidIds` rather than `uuidIds`: ids land in `uuid` columns, which
 * cannot hold `sga_<uuid>`. The store says so loudly if this is got wrong.
 */

export interface WorkerOptions {
  db: Db;
  orgId: string;
  registry: IntegrationRegistry;
  /**
   * Explicit override, mainly for tests. Production wiring should prefer
   * `llm` below — passing both is an error, since it is ambiguous which one
   * the caller actually meant to run.
   */
  intel?: SessionIntel;
  /**
   * The real session-intel primitive when given; the deterministic stub
   * otherwise. Consent, gating and the evidence-span discipline all live in
   * `createPrimitiveSessionIntel` — this is only the wiring point.
   */
  llm?: LlmProvider;
  /** Where `ai_runs` rows land. Discarded (no cost dashboard) if omitted. */
  runs?: AiRunSink;
  role?: string;
  /**
   * The document config this process already resolved (DB row or env), used by
   * the resolvers only when no `integration_bindings` row answers. `main-live`
   * passes the winner of its one `resolveDocumentConfig` call rather than
   * re-reading env, so the adapter and the playbook link in messages can never
   * disagree about whether a guideline doc is configured — they did, once.
   */
  documentConfigFallback?: DocumentConfigFallback;
  ids?: IdFactory;
  now?: () => Date;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
  onTrace?: (line: TraceLine) => void;
  /**
   * Periodic (not per-event) sweeps — nudge reminders, progress/risk
   * assessment, and the read-model digest. Each is off unless configured, and
   * each runs only against this worker's own `orgId`: the sweep runners built
   * in `sweeps.ts` and `digest.ts` are constructed once, here, closed over
   * `options.db`/`options.orgId`, the same "one worker, one tenant" shape the
   * relay and the timer tick already have. See `scheduler.ts` for why this is
   * ordinary interval polling rather than another queue.
   */
  schedules?: {
    nudge?: { intervalMs: number };
    progress?: { intervalMs: number };
    digest?: { intervalMs: number; windowMs?: number };
    /**
     * Syncs `risk_findings`/`nudges` (and any other registered report type,
     * see `apps/worker/src/reports.ts`) into the org's configured Google
     * Spreadsheet. A no-op tick (not an error) when no `sheet` adapter is
     * bound or no destination is configured yet — the same "off unless
     * configured" shape every other sweep here has.
     */
    reportSync?: { intervalMs: number; spreadsheetTitle?: string };
    /**
     * Re-probe every bound adapter and refresh `integration_bindings
     * .capabilities` (ADR-0006: "cached capabilities go stale silently").
     * Complements the boot probe — `probeCapabilities()` — rather than
     * replacing it: the first scheduler tick comes after the first pass, and
     * a pass run on an empty cache degrades every proposal it makes.
     */
    capabilityProbe?: { intervalMs: number };
  };
  /**
   * Env-only fallback for the `sheet` destination, read only when no
   * `integration_bindings` row for that slot exists yet — same precedence
   * rule `documentConfigFallback` follows for `document`. Ignored unless
   * `schedules.reportSync` is configured.
   */
  reportSyncEnv?: SheetEnv;
}

export interface Worker {
  engine: SagaEngine;
  /**
   * Probe every adapter bound in `registry` and cache the result on this
   * org's `integration_bindings` rows — the only place the Postgres resolvers
   * read capabilities from. Call once at boot, before the first `pass()`:
   * this process's adapters are fixed at construction, so boot is ADR-0006's
   * "connect time". Never throws for a failing probe (it is recorded and
   * warned); a database error does throw, as any other boot failure would.
   */
  probeCapabilities(): Promise<ProbeCapabilitiesResult>;
  /**
   * One pass: drain the outbox, then fire due timers. `timers` is how many
   * were due; `tick` breaks that down — a timer step that threw is counted in
   * `tick.failed` (retried after backoff) or `tick.parked` (given up on, and
   * listed by `stuck-sagas`), never thrown out of the pass.
   */
  pass(): Promise<{ relay: RelayResult; timers: number; tick: TickResult }>;
  /**
   * One scheduler check: any configured sweep that is due runs, scoped to
   * this worker's own org. A no-op when `schedules` was never configured.
   */
  sweep(): Promise<SchedulerTickResult>;
}

export function createWorker(options: WorkerOptions): Worker {
  if (options.intel && options.llm) {
    throw new Error("createWorker: pass either `intel` or `llm`, not both");
  }
  const ids = options.ids ?? bareUuidIds;
  const now = options.now ?? (() => new Date());
  const scoped = options.role === undefined ? {} : { role: options.role };
  const intel =
    options.intel ??
    (options.llm
      ? createPrimitiveSessionIntel({
          llm: options.llm,
          ids,
          ...(options.runs ? { runs: options.runs } : {}),
          ...(options.onWarn ? { onWarn: options.onWarn } : {}),
        })
      : heuristicSessionIntel(ids));

  const resolvers = new PostgresSagaResolvers({
    db: options.db,
    orgId: options.orgId,
    registry: options.registry,
    ...scoped,
    ...(options.documentConfigFallback
      ? { documentConfigFallback: options.documentConfigFallback }
      : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });
  const probeCapabilities = (): Promise<ProbeCapabilitiesResult> =>
    probeAndCacheCapabilities({
      db: options.db,
      orgId: options.orgId,
      registry: options.registry,
      ...scoped,
      now,
      ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    });
  const sink = new PostgresEventSink(options.db, { ...scoped, now });
  const projector = new PostgresProjector(options.db, scoped);
  const store = new PostgresSagaStore(options.db);

  const engine = new SagaEngine({
    store,
    resolvers,
    ids,
    now,
    // Both the roster importer and the matching primitive emit pair.activated,
    // and neither needs to know the other exists.
    starters: [{ on: ["pair.activated"], sagaName: SESSION_LIFECYCLE }],
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
    // One throwing instance is recorded and backed off rather than aborting
    // the pass; this is where an operator hears about it.
    ...(options.onWarn
      ? {
          onStepFailed: (failure) =>
            options.onWarn?.(
              failure.parked ? "saga step failed; instance parked" : "saga step failed; will retry",
              {
                instanceId: failure.instanceId,
                subjectRef: failure.subjectRef,
                state: failure.state,
                attempts: failure.attempts,
                retryAt: failure.retryAt,
                error: failure.error.message,
              },
            ),
        }
      : {}),
    runEffect: createEffectRunner({
      registry: options.registry,
      log: sink,
      resolvers,
      sources: new PostgresSessionSourceStore(options.db, {
        orgId: options.orgId,
        ...scoped,
      }),
      intel,
      ids,
      ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    }),
  });
  engine.register(createSessionLifecycle());

  const sweepDeps = {
    db: options.db,
    orgId: options.orgId,
    registry: options.registry,
    ...scoped,
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.runs ? { runs: options.runs } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    now,
  };

  const jobs: SweepJob[] = [];
  if (options.schedules?.progress) {
    const run = createProgressSweepRunner(sweepDeps);
    jobs.push({ name: "progress", intervalMs: options.schedules.progress.intervalMs, run });
  }
  if (options.schedules?.nudge) {
    const run = createNudgeSweepRunner(sweepDeps);
    jobs.push({ name: "nudge", intervalMs: options.schedules.nudge.intervalMs, run });
  }
  if (options.schedules?.digest) {
    const digestConfig = options.schedules.digest;
    jobs.push({
      name: "digest",
      intervalMs: digestConfig.intervalMs,
      run: (): Promise<DigestSummary> =>
        runDigestSweep({
          db: options.db,
          orgId: options.orgId,
          sink,
          ...(digestConfig.windowMs !== undefined ? { windowMs: digestConfig.windowMs } : {}),
          ...scoped,
          now,
        }),
    });
  }
  if (options.schedules?.reportSync) {
    const reportSyncConfig = options.schedules.reportSync;
    const run = createReportSyncRunner({
      db: options.db,
      orgId: options.orgId,
      registry: options.registry,
      ...scoped,
      ...(options.reportSyncEnv ? { env: options.reportSyncEnv } : {}),
      ...(reportSyncConfig.spreadsheetTitle
        ? { spreadsheetTitle: reportSyncConfig.spreadsheetTitle }
        : {}),
      ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    });
    jobs.push({
      name: "report-sync",
      intervalMs: reportSyncConfig.intervalMs,
      run: (): Promise<SyncReportsResult | null> => run(),
    });
  }
  if (options.schedules?.capabilityProbe) {
    jobs.push({
      name: "capability-probe",
      intervalMs: options.schedules.capabilityProbe.intervalMs,
      run: probeCapabilities,
    });
  }
  const scheduler = new Scheduler({
    jobs,
    now,
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  return {
    engine,
    probeCapabilities,
    async pass() {
      const relay = await relayOnce(options.db, engine, {
        // Scoped: this worker's resolvers belong to one tenant.
        orgId: options.orgId,
        now,
        project: (event) => projector.apply(event),
        ...(options.onWarn
          ? {
              onDeadLettered: (event, error) =>
                options.onWarn?.("event dead-lettered", {
                  event: event.name,
                  error: error.message,
                }),
            }
          : {}),
      });
      const tick = await engine.tick(options.orgId);
      return { relay, timers: tick.fired, tick };
    },
    sweep() {
      return scheduler.tick();
    },
  };
}
