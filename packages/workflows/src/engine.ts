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

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.runEffect = opts.runEffect;
    this.resolvers = opts.resolvers;
    this.ids = opts.ids ?? uuidIds;
    this.now = opts.now ?? (() => new Date());
    this.terminalEvents = opts.terminalEvents ?? DEFAULT_TERMINAL;
    this.starters = opts.starters ?? [];
    this.onTrace = opts.onTrace;
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

  /** Returns how many instances advanced. */
  async deliver(event: DomainEvent): Promise<number> {
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
      await this.advance(instance, { kind: "event", event });
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
   */
  async tick(orgId?: string): Promise<number> {
    const due = await this.store.findDue(this.now(), orgId);
    for (const instance of due) {
      await this.advance(instance, {
        kind: "timeout",
        at: instance.timeoutAt ?? this.now().toISOString(),
      });
    }
    return due.length;
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
      const value = await this.runEffect(effect, { instance, key, now });
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
