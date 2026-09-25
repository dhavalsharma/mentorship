import {
  defaultPolicy,
  sequentialIds,
  type Interval,
  type LlmProvider,
  type ProgramPolicy,
} from "@mentorship/core";
import type { AiRunSink } from "@mentorship/ai";
import { EventLog } from "@mentorship/events";
import {
  FakeCalendar,
  FakeConversation,
  FakeDm,
  FakeDocument,
  FakeTranscript,
  IntegrationRegistry,
  Recorder,
} from "@mentorship/integrations";
import { createPrimitiveSessionIntel } from "@mentorship/primitive-session-intel";
import {
  createEffectRunner,
  createSessionLifecycle,
  Dispatcher,
  heuristicSessionIntel,
  MemorySagaStore,
  SagaEngine,
  SESSION_LIFECYCLE,
  type SessionIntel,
  type TraceLine,
} from "@mentorship/workflows";
import { Clock, World } from "./world.js";

export const ORG_ID = "org_wekan";

/**
 * The integration profile: which adapter fills each slot. Swapping "fake-chat"
 * for "slack" and "fake-calendar" for "google" is the whole change needed to
 * run this against real tooling — the saga does not move.
 */
export const DEMO_PROFILE = {
  conversation: "fake-chat",
  dm: "fake-dm",
  calendar: "fake-calendar",
  conferencing: "fake-calendar",
  transcript: "fake-transcript",
  document: "fake-doc",
  sheet: null,
  dashboard: null,
};

export interface BootstrapOptions {
  startAt?: string;
  policy?: Partial<Parameters<typeof defaultPolicy>[0]>;
  busy?: Record<string, Interval[]>;
  /** How many fetches before the fake transcript appears — exercises the backoff. */
  transcriptAvailableAfter?: number;
  transcription?: "native" | "byo" | "none";
  recordingConsent?: boolean;
  /** Leave slots out to see the documented degraded paths. */
  omitSlots?: ("conversation" | "dm" | "calendar" | "transcript" | "document")[];
  onTrace?: (line: TraceLine) => void;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * The deterministic stub runs unless one of these is given. `llm` is the
   * common case — a `DeterministicProvider` from `@mentorship/ai` drives the
   * real primitive through the saga exactly as the worker would; `intel` is
   * an escape hatch for a caller that wants full control.
   */
  llm?: LlmProvider;
  runs?: AiRunSink;
  intel?: SessionIntel;
}

export function bootstrap(opts: BootstrapOptions = {}) {
  const clock = new Clock(opts.startAt ?? "2026-09-11T06:00:00.000Z");
  const ids = sequentialIds();
  const log = new EventLog(ids, clock.now);
  const recorder = new Recorder();
  const omit = new Set(opts.omitSlots ?? []);

  const policy: ProgramPolicy = defaultPolicy({
    pairing: { mode: "imported", mentorCapacityDefault: 2 },
    cadence: { everyDays: 14, label: "fortnightly", reminderLeadHours: 24 },
    consent: { aiProcessing: "optional", recording: "opt_in" },
    ...(opts.policy ?? {}),
  });

  const registry = new IntegrationRegistry();
  if (!omit.has("conversation")) {
    registry.bind(new FakeConversation(recorder));
  }
  if (!omit.has("dm")) registry.bind(new FakeDm(recorder));
  if (!omit.has("calendar")) {
    registry.bind(new FakeCalendar(recorder, opts.busy ?? {}));
  }
  if (!omit.has("transcript")) {
    registry.bind(
      new FakeTranscript(recorder, {
        autoTranscription: opts.transcription ?? "native",
        availableAfterFetches: opts.transcriptAvailableAfter ?? 1,
      }),
    );
  }
  if (!omit.has("document")) registry.bind(new FakeDocument(recorder));

  const world = new World(
    ORG_ID,
    policy,
    log,
    registry,
    clock,
    { aiProcessing: true, recording: opts.recordingConsent ?? true },
    ids,
  );

  const intel =
    opts.intel ??
    (opts.llm
      ? createPrimitiveSessionIntel({
          llm: opts.llm,
          ids,
          ...(opts.runs ? { runs: opts.runs } : {}),
          ...(opts.onWarn ? { onWarn: opts.onWarn } : {}),
        })
      : heuristicSessionIntel(ids));

  const store = new MemorySagaStore();
  const engine = new SagaEngine({
    store,
    resolvers: world,
    ids,
    now: clock.now,
    // Both the roster importer and the matching primitive emit pair.activated.
    starters: [{ on: ["pair.activated"], sagaName: SESSION_LIFECYCLE }],
    onTrace: opts.onTrace,
    runEffect: createEffectRunner({
      registry,
      log,
      resolvers: world,
      sources: world,
      intel,
      ids,
      onWarn: opts.onWarn,
    }),
  });
  engine.register(createSessionLifecycle());

  const dispatcher = new Dispatcher(log, engine);

  return { clock, ids, log, recorder, registry, world, store, engine, dispatcher, policy };
}

export type Harness = ReturnType<typeof bootstrap>;

/** Fast-forward to the next pending timer and let everything settle. */
export async function advanceToNextTimer(h: Harness): Promise<string | null> {
  const next = await h.engine.nextTimeout();
  if (!next) return null;
  h.clock.advanceTo(next);
  await h.dispatcher.settle();
  return next;
}
