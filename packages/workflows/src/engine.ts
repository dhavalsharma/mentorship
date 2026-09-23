import type {
  DomainEvent,
  Effect,
  EventName,
  IdFactory,
  Saga,
  SagaContext,
  SagaInput,
  SagaInstance,
  SagaResolvers,
} from "@mentorship/core";
import { stateName, uuidIds } from "@mentorship/core";
import { SagaConflictError, type SagaStore } from "./store.js";

export interface EffectContext {
  instance: SagaInstance;
  /** Stable per (instance, step, index) — this is what makes a retry a no-op. */
  key: string;
  now: Date;
  /**
   * How many times this step has already failed and been retried by the
   * timer tick (0 on the first try). Lets the runner decide that an effect
   * which keeps failing should degrade rather than wedge the whole step —
   * see the `dm` case in `createEffectRunner`.
   */
  attempt: number;
}

export type EffectRunner = (
  effect: Effect,
  ctx: EffectContext,
) => Promise<unknown>;

export interface EngineOptions {
  store: SagaStore;
  runEffect: EffectRunner;
  resolvers: SagaResolvers;
  ids?: IdFactory;
  now?: () => Date;
  /**
   * Events that terminate any instance for the same subject, from any state.
   * Cheaper and less error-prone than adding them to every state's waitFor.
   */
  terminalEvents?: EventName[];
  /**
   * Declarative "this event starts that saga". `pair.activated` is emitted
   * identically by the matching primitive and by the roster importer, so both
   * paths start the session lifecycle without either knowing about the other.
   */
  starters?: { on: EventName[]; sagaName: string }[];
  onTrace?: (line: TraceLine) => void;
  /**
   * A timer-driven step that throws is retried with backoff, then parked
   * (`status: "failed"`) after this many consecutive failures. Mirrors the
   * relay's `maxAttempts`/dead-letter for the same reason: one poisonous
   * instance must never stop the ones behind it, and must never hot-loop.
   */
  maxStepAttempts?: number;
  /** Backoff before retry n (1-based), in milliseconds. */
  stepBackoffMs?: (attempt: number) => number;
  /** Fired for every failed timer step, parked or not. */
  onStepFailed?: (failure: StepFailure) => void;
}

export interface StepFailure {
  instanceId: string;
  orgId: string;
  subjectRef: string;
  state: string;
  error: Error;
  /** Consecutive failures at this step, including this one. */
  attempts: number;
  parked: boolean;
  retryAt: string | null;
}

export interface TickResult {
  /** Due instances found — advanced, failed or parked. */
  fired: number;
  advanced: number;
  /** Threw, recorded, and will be retried after backoff. */
  failed: number;
  /** Threw for the `maxStepAttempts`-th time and stopped being scheduled. */
  parked: number;
}

export interface TraceLine {
  at: string;
  instanceId: string;
  input: string;
  from: string;
  to: string;
  effects: string[];
  note?: string;
}

const DEFAULT_TERMINAL: EventName[] = ["pair.ended"];

const DEFAULT_MAX_STEP_ATTEMPTS = 5;

/** Same curve as the relay's: 4s, 16s, 64s, 256s… capped at 15 minutes. */
const defaultStepBackoff = (attempt: number): number =>
  Math.min(4 ** attempt * 1000, 15 * 60 * 1000);

/**
 * A step threw partway through its effects. Carries the ledger as it stood,
 * so the recorded failure keeps the effects that *did* complete and the retry
 * skips them (invariant 6) — without this, retrying a reminder step whose DM
 * failed would re-post the shared reminder into the thread on every attempt.
 * The message is the cause's, so the relay's `lastError` reads the same.
 */
class StepEffectsError extends Error {
  constructor(
    readonly original: unknown,
    readonly completed: Record<string, unknown>,
    readonly ran: string[],
  ) {
    super(original instanceof Error ? original.message : String(original), {
      cause: original,
    });
    this.name = original instanceof Error ? original.name : "Error";
  }
}

export class SagaEngine {
  private readonly sagas = new Map<string, Saga<unknown>>();
  private readonly store: SagaStore;
  private readonly runEffect: EffectRunner;
  private readonly resolvers: SagaResolvers;
  private readonly ids: IdFactory;
  private readonly now: () => Date;
  private readonly terminalEvents: EventName[];
  private readonly starters: { on: EventName[]; sagaName: string }[];
  private readonly onTrace?: (line: TraceLine) => void;
  private readonly maxStepAttempts: number;
  private readonly stepBackoff: (attempt: number) => number;
  private readonly onStepFailed?: (failure: StepFailure) => void;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.runEffect = opts.runEffect;
    this.resolvers = opts.resolvers;
    this.ids = opts.ids ?? uuidIds;
    this.now = opts.now ?? (() => new Date());
    this.terminalEvents = opts.terminalEvents ?? DEFAULT_TERMINAL;
    this.starters = opts.starters ?? [];
    this.onTrace = opts.onTrace;
    this.maxStepAttempts = opts.maxStepAttempts ?? DEFAULT_MAX_STEP_ATTEMPTS;
    this.stepBackoff = opts.stepBackoffMs ?? defaultStepBackoff;
    this.onStepFailed = opts.onStepFailed;
  }

  register<S>(saga: Saga<S>): void {
    this.sagas.set(saga.name, saga as Saga<unknown>);
  }

  async start(input: {
    sagaName: string;
    orgId: string;
    subjectRef: string;
    payload?: Record<string, unknown>;
  }): Promise<SagaInstance> {
    const saga = this.mustGet(input.sagaName);
    const existing = await this.store.findBySubject(
      input.sagaName,
      input.subjectRef,
    );
    // One live instance per subject. Restarting a running saga is almost always
    // a double-delivery bug, not an intention.
    if (existing && existing.status === "running") return existing;

    const at = this.now().toISOString();
    const instance: SagaInstance = {
      id: this.ids.next("saga"),
      orgId: input.orgId,
      sagaName: input.sagaName,
      subjectRef: input.subjectRef,
      state: saga.initial(input.payload),
      awaitingEvent: null,
      timeoutAt: null,
      version: 0,
      stepIndex: 0,
      completedEffects: {},
      history: [],
      status: "running",
      createdAt: at,
      updatedAt: at,
    };
    const created = await this.store.create(instance);
    return this.advance(created, { kind: "start", payload: input.payload });
  }

  /**
   * Returns how many instances advanced.
   *
   * `attempt` is how many times the relay has already failed to deliver this
   * event (its `events.attempts`), passed through to the effect runner the
   * same way a timer retry passes its own count — so an effect that degrades
   * after a retry (a failing DM) degrades on the event path too, rather than
   * throwing until the relay dead-letters the event and strands the saga.
   */
  async deliver(
    event: DomainEvent,
    options: { attempt?: number } = {},
  ): Promise<number> {
    let advanced = 0;

    if (this.terminalEvents.includes(event.name)) {
      for (const instance of await this.store.list()) {
        if (
          instance.status === "running" &&
          instance.subjectRef === event.subjectRef
        ) {
          await this.terminate(instance, `terminated by ${event.name}`);
          advanced++;
        }
      }
      if (advanced > 0) return advanced;
    }

    for (const starter of this.starters) {
      if (!starter.on.includes(event.name)) continue;
      await this.start({
        sagaName: starter.sagaName,
        orgId: event.orgId,
        subjectRef: event.subjectRef,
        payload: event.payload,
      });
      advanced++;
    }

    for (const instance of await this.store.findAwaiting(event)) {
      await this.advance(instance, { kind: "event", event }, options.attempt ?? 0);
      advanced++;
    }
    return advanced;
  }

  /** Earliest pending timer across running instances — used to fast-forward. */
  async nextTimeout(): Promise<string | null> {
    const times = (await this.store.list())
      .filter((i) => i.status === "running" && i.timeoutAt)
      .map((i) => i.timeoutAt!)
      .sort();
    return times[0] ?? null;
  }

  /**
   * Fire every due timer. In production this is a pg-boss scheduled job.
   *
   * `orgId` scopes the scan for a single-tenant worker sharing a database with
   * other tenants — omitting it (as the in-memory tests and the dispatcher do)
   * ticks every running instance. Without this a worker built for one org can
   * pick up another org's due instance, fail resolving it against its own
   * org-scoped resolvers, and abort the whole pass ahead of its own timers.
   *
   * Failures are isolated per instance, for the same reason one level down: a
   * step that throws (a vendor outage, a resolver that cannot find its row) is
   * recorded on *that* instance — a history entry carrying the error, its
   * ledger as far as it got, and a backed-off `timeoutAt` — and the loop moves
   * on. Before this, one throwing instance rejected the whole tick, so every
   * other due timer in the org was skipped on every pass for as long as the
   * cause lasted. After `maxStepAttempts` consecutive failures the instance is
   * parked (`status: "failed"`), which is what `listStuckSagaInstances`
   * surfaces, rather than retried forever. Only a failure to *record* the
   * failure (the store itself is down) still propagates — at that point
   * nothing else in the pass can succeed either.
   *
   * Event-driven steps (`deliver`) are deliberately not wrapped: a throw there
   * propagates to the relay, which already has its own attempts, backoff and
   * dead-letter for the event.
   */
  async tick(orgId?: string): Promise<TickResult> {
    const due = await this.store.findDue(this.now(), orgId);
    const result: TickResult = {
      fired: due.length,
      advanced: 0,
      failed: 0,
      parked: 0,
    };
    for (const instance of due) {
      const attempt = consecutiveFailures(instance);
      try {
        await this.advance(
          instance,
          { kind: "timeout", at: instance.timeoutAt ?? this.now().toISOString() },
          attempt,
        );
        result.advanced++;
      } catch (caught) {
        const parked = await this.recordFailure(instance, caught, attempt + 1);
        if (parked) result.parked++;
        else result.failed++;
      }
    }
    return result;
  }

  async instances(): Promise<SagaInstance[]> {
    return this.store.list();
  }

  private mustGet(name: string): Saga<unknown> {
    const saga = this.sagas.get(name);
    if (!saga) throw new Error(`saga not registered: ${name}`);
    return saga;
  }

  private async advance(
    instance: SagaInstance,
    input: SagaInput,
    attempt = 0,
  ): Promise<SagaInstance> {
    const saga = this.mustGet(instance.sagaName);
    const now = this.now();
    const ctx: SagaContext = {
      orgId: instance.orgId,
      subjectRef: instance.subjectRef,
      now,
      resolve: this.resolvers,
      ids: this.ids,
      effectResults: instance.completedEffects,
    };

    const from = stateName(instance.state);
    const result = await saga.step(instance.state, input, ctx);

    const effects = result.effects ?? [];
    const completed = { ...instance.completedEffects };
    const ran: string[] = [];

    for (const [index, effect] of effects.entries()) {
      const key = `${instance.id}:${instance.stepIndex}:${index}`;
      if (key in completed) {
        // Already done on a previous attempt at this step. Skipping here is the
        // difference between a retry and a second calendar invite.
        continue;
      }
      let value: unknown;
      try {
        value = await this.runEffect(effect, { instance, key, now, attempt });
      } catch (error) {
        throw new StepEffectsError(error, completed, ran);
      }
      completed[key] = value ?? null;
      ran.push(effect.type);
    }

    const to = stateName(result.next);
    const entry = {
      at: now.toISOString(),
      stepIndex: instance.stepIndex,
      input: describeInput(input),
      from,
      to,
      effects: ran,
      waitFor: result.waitFor?.names ?? null,
      timeoutAt: result.timeoutAt ?? null,
      done: Boolean(result.done),
    };

    const updated: SagaInstance = {
      ...instance,
      state: result.next,
      awaitingEvent: result.waitFor ?? null,
      timeoutAt: result.timeoutAt ?? null,
      version: instance.version + 1,
      stepIndex: instance.stepIndex + 1,
      completedEffects: completed,
      history: [...instance.history, entry],
      status: result.done ? "done" : "running",
      updatedAt: now.toISOString(),
    };

    this.onTrace?.({
      at: entry.at,
      instanceId: instance.id,
      input: entry.input,
      from,
      to,
      effects: ran,
    });

    try {
      return await this.store.save(updated, instance.version);
    } catch (error) {
      if (error instanceof SagaConflictError) {
        // Someone else advanced this instance first. The effects we ran are
        // keyed, so the winning writer's retry will skip them.
        const fresh = await this.store.get(instance.id);
        if (fresh) return fresh;
      }
      throw error;
    }
  }

  /**
   * Records a failed timer step on the instance itself and returns whether it
   * was parked. The instance keeps its state, its `stepIndex` (so effect keys
   * stay stable across retries) and its `awaitingEvent` (an event can still
   * move it on — a cancelled session should not wait out a DM outage).
   */
  private async recordFailure(
    instance: SagaInstance,
    caught: unknown,
    attempts: number,
  ): Promise<boolean> {
    const partial = caught instanceof StepEffectsError ? caught : null;
    const original = partial ? partial.original : caught;
    const error = original instanceof Error ? original : new Error(String(original));
    const now = this.now();
    const at = now.toISOString();
    const parked = attempts >= this.maxStepAttempts;
    const retryAt = parked
      ? null
      : new Date(now.getTime() + this.stepBackoff(attempts)).toISOString();
    const state = stateName(instance.state);
    const ran = partial ? partial.ran : [];
    const note = parked
      ? `parked after ${attempts} failed attempts`
      : `step failed (attempt ${attempts}); retrying at ${retryAt}`;

    const updated: SagaInstance = {
      ...instance,
      awaitingEvent: parked ? null : instance.awaitingEvent,
      timeoutAt: retryAt,
      version: instance.version + 1,
      completedEffects: partial ? partial.completed : instance.completedEffects,
      history: [
        ...instance.history,
        {
          at,
          stepIndex: instance.stepIndex,
          input: "timeout",
          from: state,
          to: state,
          effects: ran,
          waitFor: parked ? null : (instance.awaitingEvent?.names ?? null),
          timeoutAt: retryAt,
          // Parked means "no longer scheduled": `done` in the bookkeeping
          // sense invariant 7 checks, while `status: "failed"` says why.
          done: parked,
          note,
          error: error.message.slice(0, 2000),
          attempt: attempts,
        },
      ],
      status: parked ? "failed" : "running",
      updatedAt: at,
    };

    try {
      await this.store.save(updated, instance.version);
    } catch (saveError) {
      // Another writer advanced the instance while this step was failing —
      // theirs is the live row now, and there is nothing of ours to record.
      if (!(saveError instanceof SagaConflictError)) throw saveError;
    }

    this.onTrace?.({
      at,
      instanceId: instance.id,
      input: "timeout",
      from: state,
      to: parked ? "failed" : state,
      effects: ran,
      note: `${note}: ${error.message}`,
    });
    this.onStepFailed?.({
      instanceId: instance.id,
      orgId: instance.orgId,
      subjectRef: instance.subjectRef,
      state,
      error,
      attempts,
      parked,
      retryAt,
    });

    if (parked) {
      // Best effort: tell a human, through the same `escalate` effect a saga
      // would use. The cause may well make this fail too (a resolver that
      // cannot find the pairing), and the parked row is the durable record
      // either way — it is what `stuck-sagas` lists.
      try {
        await this.runEffect(
          {
            type: "escalate",
            reason: "saga_step_failed",
            detail: `${state}: ${error.message}`.slice(0, 500),
          },
          {
            instance: updated,
            key: `${instance.id}:${instance.stepIndex}:parked`,
            now,
            attempt: attempts,
          },
        );
      } catch {
        // Already recorded; see above.
      }
    }
    return parked;
  }

  private async terminate(
    instance: SagaInstance,
    note: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    await this.store.save(
      {
        ...instance,
        status: "done",
        awaitingEvent: null,
        timeoutAt: null,
        version: instance.version + 1,
        updatedAt: at,
        history: [
          ...instance.history,
          {
            at,
            stepIndex: instance.stepIndex,
            input: "terminal-event",
            from: stateName(instance.state),
            to: "ended",
            effects: [],
            note,
          },
        ],
      },
      instance.version,
    );
    this.onTrace?.({
      at,
      instanceId: instance.id,
      input: "terminal-event",
      from: stateName(instance.state),
      to: "ended",
      effects: [],
      note,
    });
  }
}

/**
 * Consecutive failed attempts at the instance's current step, read back from
 * history — failures are recorded without advancing `stepIndex`, so they are
 * exactly the trailing entries at that index that carry an `error`.
 */
function consecutiveFailures(instance: SagaInstance): number {
  let count = 0;
  for (let i = instance.history.length - 1; i >= 0; i--) {
    const entry = instance.history[i]!;
    if (entry.stepIndex !== instance.stepIndex || entry.error === undefined) break;
    count++;
  }
  return count;
}

function describeInput(input: SagaInput): string {
  switch (input.kind) {
    case "start":
      return "start";
    case "timeout":
      return "timeout";
    case "event":
      return input.event.name;
  }
}
