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
  type TraceLine,
} from "@mentorship/workflows";
import {
  PostgresEventSink,
  PostgresProjector,
  PostgresSagaResolvers,
  PostgresSagaStore,
  relayOnce,
  type RelayResult,
} from "@mentorship/workflows/postgres";

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
  ids?: IdFactory;
  now?: () => Date;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
  onTrace?: (line: TraceLine) => void;
}

export interface Worker {
  engine: SagaEngine;
  /** One pass: drain the outbox, then fire due timers. */
  pass(): Promise<{ relay: RelayResult; timers: number }>;
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
    runEffect: createEffectRunner({
      registry: options.registry,
      log: sink,
      resolvers,
      intel,
      ids,
      ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    }),
  });
  engine.register(createSessionLifecycle());

  return {
    engine,
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
      const timers = await engine.tick();
      return { relay, timers };
    },
  };
}
