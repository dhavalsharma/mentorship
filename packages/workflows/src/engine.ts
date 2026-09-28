import type {
  DomainEvent,
  Effect,
  EventName,
  IdFactory,
  Saga,
  SagaContext,
  SagaInput,
  SagaInstance,
  SagaPendingStep,
  SagaResolvers,
  SagaStep,
} from "@mentorship/core";
import { matchesPattern, stateName, uuidIds } from "@mentorship/core";
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
  /**
   * A sub-ledger for an effect that fans out to several recipients — today
   * only the no-thread `broadcast`, one DM per participant. `mark` records a
   * part as done in the step's completed-effect ledger, under
   * `{key}:{part}`, so a step that fails *after* some parts landed is saved
   * with them (the engine keeps the ledger as far as it got) and a retry
   * skips them. This is what stops a retried broadcast re-sending to the
   * recipient who already got it on an adapter with no server-side dedupe
   * (Slack's `chat.postMessage`).
   *
   * Like the ledger itself it is saved only when the step fails or commits,
   * so it does not survive a process killed between a send and that save.
   * The per-recipient idempotency key covers that window only on an adapter
   * that dedupes on it (`FakeDm`, and so nightly P2, which cannot see the
   * gap). `SlackDmAdapter` never sends the key — `chat.postMessage` has no
   * such field — so on Slack a kill there re-sends that recipient's DM on
   * resume: the same at-least-once window every Slack post and DM effect
   * has (see the note in `packages/integrations/src/slack/dm.ts`). Rejected:
   * saving the row after each recipient. An extra write per DM narrows the
   * window without closing it — a kill between the send and that save is
   * the same duplicate.
   *
   * Optional so a runner can be driven without an engine (tests); absent, a
   * fan-out falls back to the adapter key alone.
   */
  parts?: {
    done(part: string): boolean;
    mark(part: string): void;
  };
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
  /**
   * Due instances found — advanced, failed or parked, plus any whose failure
   * lost a race to another writer (counted here and nowhere else).
   */
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
 * A step threw — in `step()` itself, or partway through its effects. Carries
 * the instance row as it now stands in the store (with its `pendingStep`, if
 * the step got that far) and the ledger as it stood, so the recorded failure
 * keeps the effects that *did* complete and the retry skips them (invariant
 * 6) — without this, retrying a reminder step whose DM failed would re-post
 * the shared reminder into the thread on every attempt. The message is the
 * cause's, so the relay's `lastError` reads the same.
 */
class StepFailedError extends Error {
  constructor(
    readonly original: unknown,
    readonly instance: SagaInstance,
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
    if (existing) {
      // A first step that never committed — the process died after `create`
      // (or mid-effects), or the step threw on the relay's delivery. The
      // redelivered start event is exactly the input that step was waiting
      // for, so run it; `advance` replays a recorded pending step rather than
      // deciding afresh. Without this the instance sits `running` in its
      // initial state with no wait and no timeout, forever (invariant 7).
      if (existing.status === "running" && existing.stepIndex === 0) {
        return this.advance(existing, { kind: "start", payload: input.payload });
      }
      // One instance per subject, whatever its status. A start event is
      // delivered at least once, so a second one is a redelivery, not an
      // intention — and a saga that has paused (`done`, awaiting a human) or
      // been parked (`failed`, awaiting review in stuck-sagas) is precisely
      // the one a replay must not quietly restart and re-propose into the
      // pair's thread.
      //
      // Rejected: deduping only non-`done` instances. A paused
      // SessionLifecycle *is* `done`, so that rule would still restart it —
      // e2e bug #2. Rejected: deduping by the starting event's id, which
      // would allow a deliberate second start with a fresh event. Nothing in
      // the system re-activates a pairing today; when something does, it
      // should be an explicit resume, not a second `pair.activated`.
      return existing;
    }

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
      pendingStep: null,
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
      await this.recordingEventFailure(() =>
        this.start({
          sagaName: starter.sagaName,
          orgId: event.orgId,
          subjectRef: event.subjectRef,
          payload: event.payload,
        }),
      );
      advanced++;
    }

    for (const instance of await this.store.findAwaiting(event)) {
      await this.recordingEventFailure(() =>
        this.advance(instance, { kind: "event", event }, options.attempt ?? 0),
      );
      advanced++;
    }
    return advanced;
  }

  /**
   * An event-driven step that fails still propagates — the relay owns
   * retrying and dead-lettering the event — but once its pending step is
   * recorded, the failure is recorded on the instance too: the ledger as far
   * as it got (so neither the relay's retry nor the tick repeats what already
   * ran) and a failure entry (so the attempt count a failing DM degrades on
   * is the step's, whichever path retries it). The timer is left alone: the
   * relay backs off the event, and the timer the row already carries is the
   * pending step's other way back.
   *
   * Without this, a timer step interrupted by a crash and resumed by the
   * relay's delivery of its own emitted event failed at attempt 0 on the
   * event path, unrecorded, and the tick then failed it at attempt 0 again —
   * two failures, neither of them counted towards degrading.
   */
  private async recordingEventFailure(
    fn: () => Promise<SagaInstance>,
  ): Promise<SagaInstance> {
    try {
      return await fn();
    } catch (caught) {
      if (caught instanceof StepFailedError && caught.instance.pendingStep) {
        await this.recordFailure(
          caught.instance,
          caught,
          consecutiveFailures(caught.instance) + 1,
          "event",
        );
      }
      throw caught;
    }
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
      try {
        await this.advance(
          instance,
          { kind: "timeout", at: instance.timeoutAt ?? this.now().toISOString() },
          consecutiveFailures(instance),
        );
        result.advanced++;
      } catch (caught) {
        // The row the failure belongs to is the one the step left behind —
        // with its pending step, one version on from `instance` — not the
        // stale copy `findDue` returned.
        const failedRow = caught instanceof StepFailedError ? caught.instance : instance;
        const outcome = await this.recordFailure(
          failedRow,
          caught,
          consecutiveFailures(failedRow) + 1,
        );
        if (outcome === "parked") result.parked++;
        else if (outcome === "retrying") result.failed++;
        // "superseded": another writer moved the instance on while this step
        // was failing. Counted in `fired` only — it neither failed nor was
        // advanced by this tick.
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

  /**
   * One step: decide, record the decision, execute it, commit — two writes.
   *
   * 1. `saga.step()` decides the next state and the effects (pure, apart from
   *    resolver reads and minting ids).
   * 2. The decision is saved as the instance's `pendingStep` *before* any
   *    effect runs (a write-ahead record).
   * 3. The effects run, keyed `{id}:{stepIndex}:{index}`, and the instance
   *    commits to `next`, clearing the pending step.
   *
   * Why the write-ahead record (PR #13 review findings 1 and 2): the keys are
   * only safe if one `stepIndex` only ever means one effect list. Before it,
   * a retry called `step()` again and matched the *new* list against the
   * ledger by index. A retried step could then mint a second agreement id and
   * skip the effects that had posted buttons for the first (finding 2), and a
   * *different* input — `session.cancelled` arriving while the reminder step
   * was backing off — ran its proposal under keys the reminder's partial
   * ledger already held, so the proposal was never posted (finding 1).
   *
   * With the record, any input that finds a pending step finishes *that*
   * step first — same effects, same ids, same keys — and a different input is
   * then offered to the state the instance actually landed in, if it still
   * applies there. Deferring to the pending step rather than abandoning it is
   * the point: a reminder half-sent is finished, not silently dropped, and an
   * event the step itself emitted (the `confirming` timeout's own
   * `extraction.confirmed`) is no longer read back as a verdict by the state
   * it was leaving.
   *
   * One exception, narrow on purpose: an outside event the leaving state was
   * waiting for supersedes a *failing timeout* step that has run nothing yet
   * (`supersedes`) — a participant's verdict is not demoted to the
   * auto-confirm it raced.
   *
   * Rejected alternatives:
   * - Persisting the record only when a step *fails* (in `recordFailure`).
   *   Covers a thrown effect, not a killed process: a crash mid-step still
   *   leaves no record, and the retry calls `step()` again with fresh ids.
   *   The cost of writing ahead is one extra `UPDATE` per step.
   * - Salting keys per attempt. Wrong by construction: the adapters
   *   (`FakeCalendar`, the Google event id) and `events.idempotency_key`
   *   dedupe on the key being *stable* across retries of the same step.
   * - Salting keys per input, or clearing the ledger when a different input
   *   arrives. Either one stops the key collision but abandons the pending
   *   step half-done — a shared reminder posted with its DMs never sent, or
   *   buttons posted for an agreement no state will ever wait on.
   */
  private async advance(
    instance: SagaInstance,
    input: SagaInput,
    attempt = 0,
  ): Promise<SagaInstance> {
    const pending = instance.pendingStep ?? null;
    if (pending && this.supersedes(instance, pending, input)) {
      // Decide afresh for the event, at the next `stepIndex`: the abandoned
      // step's keys are never reused, so nothing it half-did at the vendor
      // can be mistaken for this step's own. One save, below, does both.
      const now = this.now().toISOString();
      instance = {
        ...instance,
        pendingStep: null,
        stepIndex: instance.stepIndex + 1,
        history: [
          ...instance.history,
          {
            at: now,
            stepIndex: instance.stepIndex,
            input: pending.input,
            from: pending.from,
            to: pending.from,
            effects: [],
            waitFor: instance.awaitingEvent?.names ?? null,
            timeoutAt: instance.timeoutAt,
            done: false,
            note: `timeout step superseded by ${describeInput(input)} before any of its effects ran`,
          },
        ],
      };
    } else if (pending) {
      const { row, won } = await this.completePending(
        instance,
        pending,
        Math.max(attempt, consecutiveFailures(instance)),
        inputKey(input) === pending.inputKey ? undefined : describeInput(input),
      );
      // The same input redelivered: that step is now done, and so is this call.
      if (!won || inputKey(input) === pending.inputKey) return row;
      if (!this.stillApplies(row, input)) return row;
      return this.advance(
        row,
        input,
        input.kind === "timeout" ? consecutiveFailures(row) : attempt,
      );
    }

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

    let result: SagaStep<unknown>;
    try {
      result = await saga.step(instance.state, input, ctx);
    } catch (error) {
      throw new StepFailedError(error, instance, instance.completedEffects, []);
    }

    const step: SagaPendingStep = {
      inputKey: inputKey(input),
      input: describeInput(input),
      at: now.toISOString(),
      from: stateName(instance.state),
      effects: result.effects ?? [],
      next: result.next,
      waitFor: result.waitFor ?? null,
      timeoutAt: result.timeoutAt ?? null,
      done: Boolean(result.done),
    };

    let claimed: SagaInstance;
    try {
      claimed = await this.store.save(
        {
          ...instance,
          pendingStep: step,
          version: instance.version + 1,
          // A pending step always has a way back. The row keeps the timer of
          // the state it is leaving (invariant 7 already guarantees one) — or,
          // for the very first step, which has none, a short one — so a
          // step whose delivery is dead-lettered is still finished by the
          // tick. `updatedAt` is untouched: nothing has advanced yet, and the
          // stuck-saga view reads it as "last advanced".
          timeoutAt:
            instance.timeoutAt ??
            new Date(now.getTime() + this.stepBackoff(1)).toISOString(),
        },
        instance.version,
      );
    } catch (error) {
      if (error instanceof SagaConflictError) {
        // Someone else advanced this instance first — and nothing of ours has
        // run yet, so there is nothing to reconcile.
        const fresh = await this.store.get(instance.id);
        if (fresh) return fresh;
      }
      throw error;
    }

    return (await this.completePending(claimed, step, attempt)).row;
  }

  /**
   * Runs a pending step's remaining effects and commits it. `won` is false
   * when another writer moved the row first; the effects we ran are keyed, so
   * nothing is repeated either way.
   */
  private async completePending(
    row: SagaInstance,
    step: SagaPendingStep,
    attempt: number,
    finishedFor?: string,
  ): Promise<{ row: SagaInstance; won: boolean }> {
    const now = this.now();
    const completed = { ...row.completedEffects };
    const ran: string[] = [];

    for (const [index, effect] of step.effects.entries()) {
      const key = `${row.id}:${row.stepIndex}:${index}`;
      if (key in completed) {
        // Already done on a previous attempt at this very step — the pending
        // record guarantees it is the same effect. Skipping here is the
        // difference between a retry and a second calendar invite.
        continue;
      }
      let value: unknown;
      try {
        value = await this.runEffect(effect, {
          instance: row,
          key,
          now,
          attempt,
          parts: {
            done: (part) => `${key}:${part}` in completed,
            mark: (part) => {
              completed[`${key}:${part}`] = true;
            },
          },
        });
      } catch (error) {
        throw new StepFailedError(error, row, completed, ran);
      }
      completed[key] = value ?? null;
      ran.push(effect.type);
    }

    const to = stateName(step.next);
    const entry = {
      at: now.toISOString(),
      stepIndex: row.stepIndex,
      input: step.input,
      from: step.from,
      to,
      effects: ran,
      waitFor: step.waitFor?.names ?? null,
      timeoutAt: step.timeoutAt,
      done: step.done,
      ...(finishedFor ? { note: `pending step finished before ${finishedFor}` } : {}),
    };

    const updated: SagaInstance = {
      ...row,
      state: step.next,
      awaitingEvent: step.waitFor,
      timeoutAt: step.timeoutAt,
      version: row.version + 1,
      stepIndex: row.stepIndex + 1,
      completedEffects: completed,
      pendingStep: null,
      history: [...row.history, entry],
      status: step.done ? "done" : "running",
      updatedAt: now.toISOString(),
    };

    this.onTrace?.({
      at: entry.at,
      instanceId: row.id,
      input: entry.input,
      from: step.from,
      to,
      effects: ran,
      ...(entry.note ? { note: entry.note } : {}),
    });

    try {
      return { row: await this.store.save(updated, row.version), won: true };
    } catch (error) {
      if (error instanceof SagaConflictError) {
        // Someone else advanced this instance first. The effects we ran are
        // keyed, so the winning writer's retry will skip them.
        const fresh = await this.store.get(row.id);
        if (fresh) return { row: fresh, won: false };
      }
      throw error;
    }
  }

  /**
   * Whether an event the instance's current state was waiting for should be
   * decided by that state rather than finish the timeout step in flight.
   *
   * Finishing first is right for almost every input (see `advance`), but not
   * for the one this state exists to receive, racing a timeout that has not
   * happened yet in any visible way. The case that forced it (PR #13 review):
   * a participant's Confirm arriving while the `confirming` timeout's render
   * keeps failing. Finished first, the click retried the auto-confirm, and a
   * click that finally let it through was recorded as an *unverified*
   * auto-confirm, then dropped because `feedback` does not wait for it — a
   * human verdict silently demoted to a machine guess (invariant 19).
   *
   * All four conditions, each for a reason:
   * - The pending step is a timeout. An event step is someone's answer, and
   *   is always finished.
   * - The event matches the wait the row still carries from the state the
   *   step is leaving — it is exactly what that state would have taken a
   *   moment earlier.
   * - The step has failed at least once and its ledger holds nothing for this
   *   `stepIndex`. A failure is saved with the ledger as far as it got, so
   *   "nothing" is known rather than hoped. A step that has *not* failed may
   *   be running in another process right now, or was killed after its
   *   vendor call and before any save — superseding either would do its
   *   effects twice, so those are finished as before.
   * - The event is not one this instance's own effects emitted (its
   *   `idempotencyKey` carries the effect key). That covers the one gap the
   *   previous condition leaves: a retry that ran the step's `emit` and was
   *   killed before committing. The relay then delivers the step's own
   *   auto-confirm, which must finish the step, never be read as a verdict.
   *
   * Rejected: reading the payload (`unverified: true`, no `participantId`).
   * It would work for this one saga and teach the engine a saga's vocabulary.
   */
  private supersedes(
    instance: SagaInstance,
    pending: SagaPendingStep,
    input: SagaInput,
  ): boolean {
    if (pending.inputKey !== "timeout" || input.kind !== "event") return false;
    if (!matchesPattern(input.event, instance.awaitingEvent)) return false;
    if (input.event.idempotencyKey?.startsWith(`${instance.id}:`)) return false;
    if (consecutiveFailures(instance) === 0) return false;
    const prefix = `${instance.id}:${instance.stepIndex}:`;
    return !Object.keys(instance.completedEffects).some((k) => k.startsWith(prefix));
  }

  /**
   * Whether an input that found a pending step still means anything once
   * that step has committed. An event only if the new state waits for it; a
   * timer only if the new state's own timer is due; a start never — the
   * pending step it found *was* the start.
   */
  private stillApplies(row: SagaInstance, input: SagaInput): boolean {
    if (row.status !== "running") return false;
    switch (input.kind) {
      case "start":
        return false;
      case "event":
        return matchesPattern(input.event, row.awaitingEvent);
      case "timeout":
        return row.timeoutAt !== null && Date.parse(row.timeoutAt) <= this.now().getTime();
    }
  }

  /**
   * Records a failed timer step on the instance itself. The instance keeps
   * its state, its `stepIndex` and its `pendingStep` (so the retry replays the
   * same effects under the same keys) and its `awaitingEvent` (an event can
   * still move it on — a cancelled session should not wait out a DM outage;
   * it finishes the pending step first, see `advance`).
   *
   * Returns `"superseded"` when the save loses the race to another writer: the
   * instance was moved on while this step was failing, so there is no failure
   * of ours to report — no `onStepFailed`, no parking, and above all no
   * `saga_step_failed` escalation to a human about a healthy saga.
   */
  private async recordFailure(
    instance: SagaInstance,
    caught: unknown,
    attempts: number,
    source: "timer" | "event" = "timer",
  ): Promise<"parked" | "retrying" | "superseded"> {
    const partial = caught instanceof StepFailedError ? caught : null;
    const original = partial ? partial.original : caught;
    const error = original instanceof Error ? original : new Error(String(original));
    const now = this.now();
    const at = now.toISOString();
    // Only the tick parks: an event-path failure is the relay's to give up on.
    const parked = source === "timer" && attempts >= this.maxStepAttempts;
    const retryAt = parked
      ? null
      : source === "event"
        ? instance.timeoutAt
        : new Date(now.getTime() + this.stepBackoff(attempts)).toISOString();
    const state = stateName(instance.state);
    const ran = partial ? partial.ran : [];
    const note = parked
      ? `parked after ${attempts} failed attempts`
      : source === "event"
        ? `step failed (attempt ${attempts}); the relay will redeliver`
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
          // The input whose step failed: a pending event step can be the one
          // a tick was finishing.
          input: instance.pendingStep?.input ?? "timeout",
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
      // theirs is the live row now, and there is nothing of ours to record,
      // report or escalate (PR #13 review finding 4).
      if (saveError instanceof SagaConflictError) return "superseded";
      throw saveError;
    }
    if (source === "event") return "retrying";

    this.onTrace?.({
      at,
      instanceId: instance.id,
      input: instance.pendingStep?.input ?? "timeout",
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
    return parked ? "parked" : "retrying";
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
        // The pair has ended; whatever a pending step still had to do no
        // longer should be done.
        pendingStep: null,
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

/** Identity of an input, for matching a redelivery to its pending step. */
function inputKey(input: SagaInput): string {
  return input.kind === "event" ? `event:${input.event.id}` : input.kind;
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
