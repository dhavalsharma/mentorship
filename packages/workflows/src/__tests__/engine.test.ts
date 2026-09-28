import { describe, expect, it, vi } from "vitest";
import {
  sequentialIds,
  type DomainEvent,
  type IdFactory,
  type Saga,
  type SagaInstance,
  type SagaResolvers,
} from "@mentorship/core";
import { FakeCalendar, Recorder } from "@mentorship/integrations";
import {
  MemorySagaStore,
  SagaConflictError,
  SagaEngine,
  type EffectRunner,
  type SagaStore,
} from "@mentorship/workflows";

const NOW = new Date("2026-09-11T06:00:00.000Z");

const noResolvers = {
  pairContext: vi.fn(),
  freeBusy: vi.fn(),
  agreement: vi.fn(),
  capabilities: vi.fn(),
} as unknown as SagaResolvers;

type TinyState = { name: "start" } | { name: "waiting" } | { name: "finished" };

function tinySaga(): Saga<TinyState> {
  return {
    name: "Tiny",
    initial: () => ({ name: "start" }),
    step(state, input) {
      if (state.name === "start") {
        return {
          next: { name: "waiting" },
          waitFor: { names: ["session.held"], subjectRef: "pairing:p1" },
          timeoutAt: "2026-09-12T06:00:00.000Z",
          effects: [{ type: "post_message", body: "hello" }],
        };
      }
      if (state.name === "waiting") {
        return {
          next: { name: "finished" },
          done: true,
          effects: [
            { type: "post_message", body: input.kind === "timeout" ? "timed out" : "got it" },
          ],
        };
      }
      return { next: state, done: true };
    },
  };
}

function event(over: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: "evt_1",
    orgId: "org_1",
    name: "session.held",
    subjectRef: "pairing:p1",
    occurredAt: NOW.toISOString(),
    version: 1,
    payload: {},
    ...over,
  };
}

function harness(store: SagaStore = new MemorySagaStore()) {
  const ran: string[] = [];
  const runEffect: EffectRunner = async (effect, ctx) => {
    ran.push(`${ctx.key}:${effect.type}`);
    return null;
  };
  const engine = new SagaEngine({
    store,
    runEffect,
    resolvers: noResolvers,
    ids: sequentialIds(),
    now: () => NOW,
  });
  engine.register(tinySaga());
  return { engine, ran, store };
}

describe("SagaEngine", () => {
  it("runs the first step on start and records its effects", async () => {
    const { engine, ran } = harness();
    const instance = await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    expect(instance.state).toEqual({ name: "waiting" });
    // Two writes per step: the pending-step record, then the commit.
    expect(instance.version).toBe(2);
    expect(instance.pendingStep).toBeNull();
    expect(ran).toEqual(["saga_001:0:0:post_message"]);
  });

  it("advances only instances whose pattern matches the event", async () => {
    const { engine } = harness();
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    expect(await engine.deliver(event({ name: "session.no_show" }))).toBe(0);
    expect(await engine.deliver(event({ subjectRef: "pairing:other" }))).toBe(0);
    expect(await engine.deliver(event())).toBe(1);
  });

  it("does not cross tenants", async () => {
    const { engine } = harness();
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    expect(await engine.deliver(event({ orgId: "org_2" }))).toBe(0);
  });

  it("fires due timers and not future ones", async () => {
    const store = new MemorySagaStore();
    const { engine } = harness(store);
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    expect((await engine.tick()).fired).toBe(0);

    const later = new SagaEngine({
      store,
      runEffect: async () => null,
      resolvers: noResolvers,
      now: () => new Date("2026-09-13T06:00:00.000Z"),
    });
    later.register(tinySaga());
    expect((await later.tick()).fired).toBe(1);
    const [instance] = await later.instances();
    expect(instance!.status).toBe("done");
  });

  it("scopes tick to one org when asked, leaving another org's due instance untouched", async () => {
    const store = new MemorySagaStore();
    const { engine } = harness(store);
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_2",
      subjectRef: "pairing:p2",
    });

    const later = new SagaEngine({
      store,
      runEffect: async () => null,
      resolvers: noResolvers,
      now: () => new Date("2026-09-13T06:00:00.000Z"),
    });
    later.register(tinySaga());

    expect((await later.tick("org_1")).fired).toBe(1);
    const instances = await later.instances();
    expect(instances.find((i) => i.orgId === "org_1")!.status).toBe("done");
    expect(instances.find((i) => i.orgId === "org_2")!.status).toBe("running");
  });

  it("keeps one live instance per subject", async () => {
    const { engine } = harness();
    const first = await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    const second = await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    expect(second.id).toBe(first.id);
    expect((await engine.instances()).length).toBe(1);
  });

  it("starts a saga from a declared starter event", async () => {
    const store = new MemorySagaStore();
    const engine = new SagaEngine({
      store,
      runEffect: async () => null,
      resolvers: noResolvers,
      ids: sequentialIds(),
      now: () => NOW,
      starters: [{ on: ["pair.activated"], sagaName: "Tiny" }],
    });
    engine.register(tinySaga());

    await engine.deliver(event({ name: "pair.activated" }));
    const [instance] = await engine.instances();
    expect(instance!.state).toEqual({ name: "waiting" });
  });

  it("terminates any instance for a subject on a terminal event", async () => {
    const { engine } = harness();
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    await engine.deliver(event({ name: "pair.ended" }));
    const [instance] = await engine.instances();
    expect(instance!.status).toBe("done");
    expect(instance!.history.at(-1)).toMatchObject({ to: "ended" });
  });

  it("appends readable history for every transition", async () => {
    const { engine } = harness();
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    await engine.deliver(event());
    const [instance] = await engine.instances();
    expect(instance!.history.map((h) => [h.input, h.from, h.to])).toEqual([
      ["start", "start", "waiting"],
      ["session.held", "waiting", "finished"],
    ]);
  });

  function flakyStore(inner: SagaStore, failOnSave: number): SagaStore {
    let saves = 0;
    return {
      create: (i) => inner.create(i),
      get: (id) => inner.get(id),
      findAwaiting: (e) => inner.findAwaiting(e),
      findDue: (n, o) => inner.findDue(n, o),
      findBySubject: (s, r) => inner.findBySubject(s, r),
      list: () => inner.list(),
      async save(instance: SagaInstance, expected: number) {
        saves++;
        if (saves === failOnSave) {
          throw new SagaConflictError(instance.id, expected, expected + 1);
        }
        return inner.save(instance, expected);
      },
    };
  }

  it("survives a lost version race by yielding to the winner, before running anything", async () => {
    const inner = new MemorySagaStore();
    const { engine, ran } = harness(flakyStore(inner, 1));
    const instance = await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    // The pending-step record is the first write, so losing the race there
    // means the loser ran no effects at all; the caller gets the stored row.
    expect(instance.state).toEqual({ name: "start" });
    expect(ran).toHaveLength(0);
  });

  it("survives a version race lost at commit without repeating the effects", async () => {
    const inner = new MemorySagaStore();
    const { engine, ran } = harness(flakyStore(inner, 2));
    await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    // The conflict is swallowed and the effect ran exactly once rather than
    // being retried into a duplicate.
    expect(ran).toHaveLength(1);
  });

  it("skips effects already completed at this step index", async () => {
    const store = new MemorySagaStore();
    const ran: string[] = [];
    const engine = new SagaEngine({
      store,
      resolvers: noResolvers,
      ids: sequentialIds(),
      now: () => NOW,
      runEffect: async (effect, ctx) => {
        ran.push(ctx.key);
        return null;
      },
    });
    engine.register(tinySaga());
    const instance = await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });

    expect(ran).toEqual(["saga_001:0:0"]);

    // Simulate a redelivery that lands on the same step index while the
    // completed-effect ledger is intact — which is exactly what the store
    // holds after a crash between running an effect and persisting the step.
    await store.save(
      { ...instance, stepIndex: 0, version: instance.version },
      instance.version,
    );
    await engine.deliver(event());

    // The effect key collides with one already in the ledger, so it is not
    // executed a second time.
    expect(ran).toEqual(["saga_001:0:0"]);
  });
});

describe("adapter-level idempotency", () => {
  it("returns the same calendar event for a repeated idempotency key", async () => {
    const calendar = new FakeCalendar(new Recorder());
    const args = {
      memberRefs: ["a@x.com", "b@x.com"],
      start: "2026-09-15T03:30:00.000Z",
      end: "2026-09-15T04:15:00.000Z",
      title: "Mentoring",
      description: "",
      withConference: true,
      withTranscription: false,
      idempotencyKey: "saga_001:3:0",
    };
    const first = await calendar.createEvent(args);
    const second = await calendar.createEvent(args);
    // Belt and braces with the engine's own effect ledger: a retried step is a
    // no-op here too, so no pair ever gets two invites for one agreement.
    expect(second.eventId).toBe(first.eventId);
  });
});

/**
 * Per-instance failure isolation in `tick()` (e2e bug #4). A timer step that
 * throws is recorded on its own instance — error in history, ledger kept,
 * `timeoutAt` backed off — and the tick carries on to the next instance.
 * After `maxStepAttempts` consecutive failures it is parked as `failed`.
 */
describe("SagaEngine.tick failure isolation", () => {
  const DUE = "2026-09-12T06:00:00.000Z";

  /** start → waiting (timer at DUE) → on timeout: post, dm, done. */
  function reminderSaga(): Saga<TinyState> {
    return {
      name: "Tiny",
      initial: () => ({ name: "start" }),
      step(state) {
        if (state.name === "start") {
          return { next: { name: "waiting" }, timeoutAt: DUE };
        }
        return {
          next: { name: "finished" },
          done: true,
          effects: [
            { type: "post_message", body: "shared reminder" },
            { type: "dm", participantId: "p", body: "private heads-up" },
          ],
        };
      },
    };
  }

  function world(opts: { failing: Set<string>; maxStepAttempts?: number }) {
    const store = new MemorySagaStore();
    let now = new Date(NOW);
    const calls: { subject: string; type: string; attempt: number }[] = [];
    const failures: { subject: string; attempts: number; parked: boolean }[] = [];
    const engine = new SagaEngine({
      store,
      resolvers: noResolvers,
      ids: sequentialIds(),
      now: () => now,
      ...(opts.maxStepAttempts ? { maxStepAttempts: opts.maxStepAttempts } : {}),
      onStepFailed: (f) =>
        failures.push({ subject: f.subjectRef, attempts: f.attempts, parked: f.parked }),
      runEffect: async (effect, ctx) => {
        calls.push({ subject: ctx.instance.subjectRef, type: effect.type, attempt: ctx.attempt });
        if (effect.type === "dm" && opts.failing.has(ctx.instance.subjectRef)) {
          throw new Error("dm outage: 503");
        }
        return null;
      },
    });
    engine.register(reminderSaga());
    const at = (iso: string) => {
      now = new Date(iso);
    };
    const bySubject = async (subject: string) =>
      (await engine.instances()).find((i) => i.subjectRef === subject)!;
    return { engine, store, calls, failures, at, bySubject };
  }

  async function startBoth(engine: SagaEngine) {
    await engine.start({ sagaName: "Tiny", orgId: "org_1", subjectRef: "pairing:bad" });
    await engine.start({ sagaName: "Tiny", orgId: "org_1", subjectRef: "pairing:good" });
  }

  it("still advances the other due instance when one throws, and does not reject", async () => {
    const w = world({ failing: new Set(["pairing:bad"]) });
    await startBoth(w.engine);
    w.at(DUE);

    const result = await w.engine.tick();
    expect(result).toEqual({ fired: 2, advanced: 1, failed: 1, parked: 0 });

    const good = await w.bySubject("pairing:good");
    expect(good.status).toBe("done");
    expect(good.state).toEqual({ name: "finished" });

    const bad = await w.bySubject("pairing:bad");
    expect(bad.status).toBe("running");
    expect(bad.state).toEqual({ name: "waiting" });
    // The step did not advance, so effect keys stay stable for the retry…
    expect(bad.stepIndex).toBe(1);
    // …the timer is backed off rather than left due (no hot loop)…
    expect(bad.timeoutAt).toBe(new Date(Date.parse(DUE) + 4_000).toISOString());
    // …and the failure is visible where every other step is.
    expect(bad.history.at(-1)).toMatchObject({
      input: "timeout",
      from: "waiting",
      to: "waiting",
      stepIndex: 1,
      error: "dm outage: 503",
      attempt: 1,
      effects: ["post_message"],
      done: false,
    });
    expect(w.failures).toEqual([{ subject: "pairing:bad", attempts: 1, parked: false }]);
  });

  it("keeps the ledger of effects that completed, so a retry does not repeat them", async () => {
    const w = world({ failing: new Set(["pairing:bad"]) });
    await startBoth(w.engine);
    w.at(DUE);
    await w.engine.tick();
    w.at("2026-09-12T07:00:00.000Z");
    await w.engine.tick();

    const posts = w.calls.filter((c) => c.subject === "pairing:bad" && c.type === "post_message");
    const dms = w.calls.filter((c) => c.subject === "pairing:bad" && c.type === "dm");
    expect(posts).toHaveLength(1);
    // The runner is told which attempt this is — that is what lets `dm` degrade.
    expect(dms.map((c) => c.attempt)).toEqual([0, 1]);
  });

  it("is not fired again before its backoff elapses", async () => {
    const w = world({ failing: new Set(["pairing:bad"]) });
    await startBoth(w.engine);
    w.at(DUE);
    await w.engine.tick();
    expect(await w.engine.tick()).toEqual({ fired: 0, advanced: 0, failed: 0, parked: 0 });
  });

  it("parks after maxStepAttempts consecutive failures, then stops being scheduled", async () => {
    const w = world({ failing: new Set(["pairing:bad"]), maxStepAttempts: 3 });
    await startBoth(w.engine);

    const results = [];
    for (const iso of [DUE, "2026-09-12T07:00:00.000Z", "2026-09-12T08:00:00.000Z"]) {
      w.at(iso);
      results.push(await w.engine.tick());
    }
    expect(results.map((r) => [r.failed, r.parked])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);

    const bad = await w.bySubject("pairing:bad");
    expect(bad.status).toBe("failed");
    expect(bad.timeoutAt).toBeNull();
    expect(bad.awaitingEvent).toBeNull();
    expect(bad.history.at(-1)).toMatchObject({ attempt: 3, done: true, timeoutAt: null });
    expect(bad.history.filter((h) => h.error !== undefined)).toHaveLength(3);
    // A human is told, through the ordinary escalate effect.
    expect(
      w.calls.filter((c) => c.subject === "pairing:bad" && c.type === "escalate"),
    ).toHaveLength(1);

    w.at("2026-09-20T00:00:00.000Z");
    expect((await w.engine.tick()).fired).toBe(0);
    expect(await w.engine.nextTimeout()).toBeNull();
  });

  it("resets the attempt count once the step succeeds", async () => {
    const failing = new Set(["pairing:bad"]);
    const w = world({ failing });
    await w.engine.start({ sagaName: "Tiny", orgId: "org_1", subjectRef: "pairing:bad" });
    w.at(DUE);
    await w.engine.tick();
    failing.clear();
    w.at("2026-09-12T07:00:00.000Z");
    expect(await w.engine.tick()).toEqual({ fired: 1, advanced: 1, failed: 0, parked: 0 });
    const bad = await w.bySubject("pairing:bad");
    expect(bad.status).toBe("done");
    expect(bad.history.at(-1)).toMatchObject({ from: "waiting", to: "finished" });
    expect(bad.history.at(-1)!.error).toBeUndefined();
  });

  it("isolates a step that throws before running any effect (a resolver failure)", async () => {
    const store = new MemorySagaStore();
    let now = new Date(NOW);
    const engine = new SagaEngine({
      store,
      resolvers: noResolvers,
      ids: sequentialIds(),
      now: () => now,
      runEffect: async () => null,
    });
    const saga: Saga<TinyState> = {
      name: "Tiny",
      initial: () => ({ name: "start" }),
      step(state, _input, ctx) {
        if (state.name === "start") return { next: { name: "waiting" }, timeoutAt: DUE };
        if (ctx.subjectRef === "pairing:bad") throw new Error("unknown pairing");
        return { next: { name: "finished" }, done: true };
      },
    };
    engine.register(saga);
    await startBoth(engine);
    now = new Date(DUE);
    expect(await engine.tick()).toEqual({ fired: 2, advanced: 1, failed: 1, parked: 0 });
    const bad = (await engine.instances()).find((i) => i.subjectRef === "pairing:bad")!;
    expect(bad.history.at(-1)).toMatchObject({ error: "unknown pairing", effects: [] });
  });
});

/**
 * PR #13 review findings 1, 2, 4 and 5, each reproduced first. 1 and 2 share
 * a root cause: a retried step used to call `saga.step()` again and match its
 * *new* effect list against the ledger by index, so the ledger could vouch for
 * effects of a different step (1) or of a different run of the same step (2).
 */
describe("SagaEngine review findings (PR #13)", () => {
  const DUE = "2026-09-12T06:00:00.000Z";

  type ArmedState =
    | { name: "start" }
    | { name: "armed"; reminded: boolean }
    | { name: "proposing"; agreementId: string };

  interface Call {
    key: string;
    type: string;
    agreementId?: string;
    attempt: number;
  }

  function recordingWorld<S>(
    saga: Saga<S>,
    opts: {
      fail?: (effect: { type: string }, ctx: { key: string; attempt: number }) => boolean;
      store?: SagaStore;
      ids?: IdFactory;
      maxStepAttempts?: number;
      starters?: { on: DomainEvent["name"][]; sagaName: string }[];
    } = {},
  ) {
    const store = opts.store ?? new MemorySagaStore();
    let now = new Date(NOW);
    const calls: Call[] = [];
    const failures: { attempts: number; parked: boolean }[] = [];
    const engine = new SagaEngine({
      store,
      resolvers: noResolvers,
      ids: opts.ids ?? sequentialIds(),
      now: () => now,
      ...(opts.maxStepAttempts ? { maxStepAttempts: opts.maxStepAttempts } : {}),
      ...(opts.starters ? { starters: opts.starters } : {}),
      onStepFailed: (f) => failures.push({ attempts: f.attempts, parked: f.parked }),
      runEffect: async (effect, ctx) => {
        if (opts.fail?.(effect, ctx)) throw new Error(`${effect.type} outage`);
        const agreementId =
          effect.type === "post_proposal"
            ? effect.agreementId
            : effect.type === "emit"
              ? (effect.payload?.["agreementId"] as string | undefined)
              : undefined;
        calls.push({
          key: ctx.key,
          type: effect.type,
          attempt: ctx.attempt,
          ...(agreementId ? { agreementId } : {}),
        });
        return null;
      },
    });
    engine.register(saga);
    return {
      engine,
      store,
      calls,
      failures,
      at: (iso: string) => {
        now = new Date(iso);
      },
      only: async () => (await engine.instances())[0]!,
    };
  }

  /** The `armed` reminder step and its `session.cancelled` escape, in miniature. */
  function armedSaga(name = "Armed"): Saga<ArmedState> {
    return {
      name,
      initial: () => ({ name: "start" }),
      step(state, input, ctx) {
        const cancelled = { names: ["session.cancelled" as const], subjectRef: ctx.subjectRef };
        if (state.name === "start") {
          return { next: { name: "armed", reminded: false }, waitFor: cancelled, timeoutAt: DUE };
        }
        if (state.name === "armed" && input.kind === "event") {
          const agreementId = ctx.ids.next("agr");
          return {
            next: { name: "proposing", agreementId },
            timeoutAt: "2026-09-20T06:00:00.000Z",
            effects: [
              { type: "ensure_thread", title: "t" },
              { type: "post_proposal", agreementId, options: [], body: "pick one" },
              { type: "emit", name: "agreement.opened", payload: { agreementId } },
            ],
          };
        }
        if (state.name === "armed" && !state.reminded) {
          return {
            next: { name: "armed", reminded: true },
            waitFor: cancelled,
            timeoutAt: "2026-09-19T06:00:00.000Z",
            effects: [
              { type: "verify_calendar_event", eventId: "cal_1" },
              { type: "post_message", body: "reminder" },
              { type: "dm", participantId: "p1", body: "heads up" },
              { type: "emit", name: "session.reminded" },
            ],
          };
        }
        return { next: state, done: true };
      },
    };
  }

  it("finding 1: an event arriving after a failed timer step runs all of its own effects", async () => {
    const w = recordingWorld(armedSaga(), {
      fail: (effect, ctx) => effect.type === "dm" && ctx.attempt === 0,
    });
    await w.engine.start({ sagaName: "Armed", orgId: "org_1", subjectRef: "pairing:p1" });
    w.at(DUE);
    expect((await w.engine.tick()).failed).toBe(1);

    w.at("2026-09-12T06:00:01.000Z");
    await w.engine.deliver(event({ name: "session.cancelled" }));

    const types = w.calls.map((c) => c.type);
    // The proposal nobody saw: before the fix these two were skipped as
    // "already done", because the failed reminder step's ledger held
    // `:1:0` and `:1:1` — keys the proposal step then reused.
    expect(types.filter((t) => t === "ensure_thread")).toHaveLength(1);
    expect(types.filter((t) => t === "post_proposal")).toHaveLength(1);
    // And no key ever vouched for two different effects.
    const byKey = new Map<string, string>();
    for (const c of w.calls) {
      expect(byKey.get(c.key) ?? c.type).toBe(c.type);
      byKey.set(c.key, c.type);
    }
    const instance = await w.only();
    expect(instance.state).toMatchObject({ name: "proposing" });
    expect(instance.status).toBe("running");
  });

  it("finding 1: the interrupted reminder is finished, not dropped, when the event wins the race", async () => {
    const w = recordingWorld(armedSaga(), {
      fail: (effect, ctx) => effect.type === "dm" && ctx.attempt === 0,
    });
    await w.engine.start({ sagaName: "Armed", orgId: "org_1", subjectRef: "pairing:p1" });
    w.at(DUE);
    await w.engine.tick();
    await w.engine.deliver(event({ name: "session.cancelled" }));
    const types = w.calls.map((c) => c.type);
    expect(types.filter((t) => t === "post_message")).toHaveLength(1);
    expect(types.filter((t) => t === "dm")).toHaveLength(1);
    // session.reminded from the finished reminder, agreement.opened from the proposal.
    expect(types.filter((t) => t === "emit")).toHaveLength(2);
    const history = (await w.only()).history.map((h) => [h.input, h.from, h.to]);
    expect(history).toEqual([
      ["start", "start", "armed"],
      ["timeout", "armed", "armed"], // the failed attempt
      ["timeout", "armed", "armed"], // the same step, completed
      ["session.cancelled", "armed", "proposing"],
    ]);
  });

  function mintingSaga(): Saga<ArmedState> {
    return {
      name: "Minting",
      initial: () => ({ name: "start" }),
      step(state, _input, ctx) {
        if (state.name === "start") {
          return { next: { name: "armed", reminded: false }, timeoutAt: DUE };
        }
        if (state.name === "armed") {
          const agreementId = ctx.ids.next("agr");
          return {
            next: { name: "proposing", agreementId },
            waitFor: { names: ["agreement.responded"], subjectRef: `agreement:${agreementId}` },
            timeoutAt: "2026-09-20T06:00:00.000Z",
            effects: [
              { type: "ensure_thread", title: "t" },
              { type: "post_proposal", agreementId, options: [], body: "pick one" },
              { type: "emit", name: "agreement.opened", payload: { agreementId } },
            ],
          };
        }
        return { next: state, done: true };
      },
    };
  }

  it("finding 2: a retried timer step replays the first attempt's effects, ids and all", async () => {
    const w = recordingWorld(mintingSaga(), {
      fail: (effect, ctx) => effect.type === "emit" && ctx.attempt === 0,
    });
    await w.engine.start({ sagaName: "Minting", orgId: "org_1", subjectRef: "pairing:p1" });
    w.at(DUE);
    expect((await w.engine.tick()).failed).toBe(1);
    w.at("2026-09-12T07:00:00.000Z");
    expect((await w.engine.tick()).advanced).toBe(1);

    const posted = w.calls.find((c) => c.type === "post_proposal")!.agreementId;
    const opened = w.calls.find((c) => c.type === "emit")!.agreementId;
    const instance = await w.only();
    expect(opened).toBe(posted);
    expect(instance.state).toEqual({ name: "proposing", agreementId: posted });
    expect(instance.awaitingEvent).toEqual({
      names: ["agreement.responded"],
      subjectRef: `agreement:${posted}`,
    });
  });

  it("finding 2: a step interrupted mid-effects is replayed with the same ids by a fresh worker", async () => {
    const store = new MemorySagaStore();
    // First worker: the emit throws on the event path, which the engine does
    // not record — the same row a process killed at that point leaves behind.
    const first = recordingWorld(armedSaga(), {
      store,
      fail: (effect) => effect.type === "emit",
    });
    await first.engine.start({ sagaName: "Armed", orgId: "org_1", subjectRef: "pairing:p1" });
    await expect(first.engine.deliver(event({ name: "session.cancelled" }))).rejects.toThrow();

    // A replacement process — its own id counter — gets the redelivered event.
    const second = recordingWorld(armedSaga(), {
      store,
      ids: { next: (prefix) => `${prefix}_restarted` },
    });
    await second.engine.deliver(event({ name: "session.cancelled" }));

    const posted = first.calls.find((c) => c.type === "post_proposal")!.agreementId;
    expect(posted).toBe("agr_001");
    expect(second.calls.find((c) => c.type === "emit")!.agreementId).toBe(posted);
    expect((await second.only()).state).toEqual({ name: "proposing", agreementId: posted });
    // The event-path failure was recorded with its ledger, so the retry ran
    // only what had not completed — and at attempt 1, the step's own count.
    expect(second.calls.map((c) => [c.type, c.attempt])).toEqual([["emit", 1]]);
  });

  it("finding 4: a failure save that loses the race is not counted, reported or escalated", async () => {
    const inner = new MemorySagaStore();
    const racing: SagaStore = {
      create: (i) => inner.create(i),
      get: (id) => inner.get(id),
      findAwaiting: (e) => inner.findAwaiting(e),
      findDue: (n, o) => inner.findDue(n, o),
      findBySubject: (s, r) => inner.findBySubject(s, r),
      list: () => inner.list(),
      async save(instance, expected) {
        // Another writer advanced the instance while this step was failing.
        if (instance.history.at(-1)?.error !== undefined) {
          throw new SagaConflictError(instance.id, expected, expected + 1);
        }
        return inner.save(instance, expected);
      },
    };
    const w = recordingWorld(armedSaga(), {
      store: racing,
      maxStepAttempts: 1,
      fail: (effect) => effect.type === "dm",
    });
    await w.engine.start({ sagaName: "Armed", orgId: "org_1", subjectRef: "pairing:p1" });
    w.at(DUE);
    const result = await w.engine.tick();
    expect(result.parked).toBe(0);
    expect(result.failed).toBe(0);
    expect(w.failures).toEqual([]);
    expect(w.calls.filter((c) => c.type === "escalate")).toEqual([]);
  });

  it("finding 5: a parked (failed) saga is not restarted by a redelivered start event", async () => {
    const w = recordingWorld(armedSaga(), {
      maxStepAttempts: 1,
      fail: (effect) => effect.type === "dm",
      starters: [{ on: ["pair.activated"], sagaName: "Armed" }],
    });
    await w.engine.deliver(event({ name: "pair.activated" }));
    w.at(DUE);
    expect((await w.engine.tick()).parked).toBe(1);

    await w.engine.deliver(event({ name: "pair.activated" }));
    const instances = await w.engine.instances();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.status).toBe("failed");
  });

  it("finding 5 / e2e bug #2: a paused (done) saga is not restarted by a redelivered start event", async () => {
    const pausing: Saga<TinyState> = {
      name: "Pausing",
      initial: () => ({ name: "start" }),
      step: () => ({
        next: { name: "finished" },
        done: true,
        effects: [{ type: "escalate", reason: "no_mutual_availability" }],
      }),
    };
    const w = recordingWorld(pausing, {
      starters: [{ on: ["pair.activated"], sagaName: "Pausing" }],
    });
    await w.engine.deliver(event({ name: "pair.activated" }));
    await w.engine.deliver(event({ name: "pair.activated" }));
    expect(await w.engine.instances()).toHaveLength(1);
    expect(w.calls.filter((c) => c.type === "escalate")).toHaveLength(1);
  });

  it("e2e P2 timeoutStepConsumesItsOwnEvent: a timer step's own emitted event is not read back as a verdict", async () => {
    type ConfirmState = { name: "start" } | { name: "confirming" } | { name: "feedback" } | { name: "verdict" };
    const confirming: Saga<ConfirmState> = {
      name: "Confirming",
      initial: () => ({ name: "start" }),
      step(state, input, ctx) {
        if (state.name === "start") {
          return {
            next: { name: "confirming" },
            waitFor: { names: ["extraction.confirmed"], subjectRef: ctx.subjectRef },
            timeoutAt: DUE,
          };
        }
        if (state.name === "confirming" && input.kind === "event") {
          return { next: { name: "verdict" }, done: true };
        }
        if (state.name === "confirming") {
          return {
            next: { name: "feedback" },
            waitFor: { names: ["feedback.submitted"], subjectRef: ctx.subjectRef },
            timeoutAt: "2026-09-19T06:00:00.000Z",
            effects: [
              { type: "emit", name: "extraction.confirmed", payload: { unverified: true } },
              { type: "render_document", title: "doc", markdown: "unverified" },
              { type: "request_feedback", participantId: "p1", question: "how was it?" },
            ],
          };
        }
        return { next: state, done: true };
      },
    };
    const w = recordingWorld(confirming, {
      fail: (effect, ctx) => effect.type === "render_document" && ctx.attempt === 0,
    });
    await w.engine.start({ sagaName: "Confirming", orgId: "org_1", subjectRef: "pairing:p1" });
    w.at(DUE);
    expect((await w.engine.tick()).failed).toBe(1);

    // The relay hands the saga its own auto-confirm.
    await w.engine.deliver(event({ name: "extraction.confirmed" }));
    const instance = await w.only();
    expect(instance.state).toEqual({ name: "feedback" });
    expect(w.calls.map((c) => c.type)).toEqual(["emit", "render_document", "request_feedback"]);
  });

  describe("a verdict arriving while the timeout step it races is failing", () => {
    type ConfirmState = { name: "start" } | { name: "confirming" } | { name: "feedback" } | { name: "verdict" };
    // The confirming timeout's shape: the render first, so a failing render
    // leaves the step with nothing run.
    const confirming: Saga<ConfirmState> = {
      name: "Confirming",
      initial: () => ({ name: "start" }),
      step(state, input, ctx) {
        if (state.name === "start") {
          return {
            next: { name: "confirming" },
            waitFor: { names: ["extraction.confirmed"], subjectRef: ctx.subjectRef },
            timeoutAt: DUE,
          };
        }
        if (state.name === "confirming" && input.kind === "event") {
          return { next: { name: "verdict" }, done: true };
        }
        if (state.name === "confirming") {
          return {
            next: { name: "feedback" },
            waitFor: { names: ["feedback.submitted"], subjectRef: ctx.subjectRef },
            timeoutAt: "2026-09-19T06:00:00.000Z",
            effects: [
              { type: "render_document", title: "doc", markdown: "unverified" },
              { type: "emit", name: "extraction.confirmed", payload: { unverified: true } },
              { type: "request_feedback", participantId: "p1", question: "how was it?" },
            ],
          };
        }
        return { next: state, done: true };
      },
    };

    async function failingTimeout(recovers = false) {
      const w = recordingWorld(confirming, {
        fail: (effect, ctx) =>
          effect.type === "render_document" && (!recovers || ctx.attempt === 0),
      });
      await w.engine.start({ sagaName: "Confirming", orgId: "org_1", subjectRef: "pairing:p1" });
      w.at(DUE);
      expect((await w.engine.tick()).failed).toBe(1);
      const instance = await w.only();
      expect(instance.pendingStep?.input).toBe("timeout");
      return { w, instance };
    }

    it("a participant's verdict supersedes a timeout step that has run nothing", async () => {
      const { w } = await failingTimeout();

      await w.engine.deliver(
        event({ id: "evt_click", name: "extraction.confirmed", payload: { participantId: "p1" } }),
      );

      const instance = await w.only();
      expect(instance.state).toEqual({ name: "verdict" });
      expect(instance.pendingStep).toBeNull();
      // Nothing of the auto-confirm happened: no unverified event, no feedback.
      expect(w.calls.map((c) => c.type)).toEqual([]);
      expect(instance.history.some((h) => h.note?.includes("superseded"))).toBe(true);
    });

    it("an event the pending step itself emitted never supersedes it", async () => {
      const { w, instance } = await failingTimeout(true);

      // The emit ran on a retry killed before the step committed: the ledger
      // shows nothing, and the relay hands the saga its own auto-confirm.
      await w.engine.deliver(
        event({
          id: "evt_own",
          name: "extraction.confirmed",
          payload: { unverified: true },
          idempotencyKey: `${instance.id}:${instance.stepIndex}:1:extraction.confirmed`,
        }),
      );

      expect((await w.only()).state).toEqual({ name: "feedback" });
    });
  });

  it("a terminal event drops a pending step rather than finishing it", async () => {
    const w = recordingWorld(armedSaga(), { fail: (effect) => effect.type === "dm" });
    await w.engine.start({ sagaName: "Armed", orgId: "org_1", subjectRef: "pairing:p1" });
    w.at(DUE);
    await w.engine.tick();
    expect((await w.only()).pendingStep).not.toBeNull();
    await w.engine.deliver(event({ name: "pair.ended" }));
    const instance = await w.only();
    expect(instance.status).toBe("done");
    expect(instance.pendingStep).toBeNull();
  });

  it("e2e P2 strandedAtStart: a start whose first step never committed is resumed, not left idle", async () => {
    const welcoming: Saga<ArmedState> = {
      name: "Welcoming",
      initial: () => ({ name: "start" }),
      step: () => ({
        next: { name: "armed", reminded: false },
        timeoutAt: DUE,
        effects: [{ type: "post_message", body: "welcome" }],
      }),
    };
    const store = new MemorySagaStore();
    const starters = [{ on: ["pair.activated" as const], sagaName: "Welcoming" }];
    const crashing = recordingWorld(welcoming, { store, starters, fail: () => true });
    await expect(crashing.engine.deliver(event({ name: "pair.activated" }))).rejects.toThrow();

    const w = recordingWorld(welcoming, { store, starters });
    await w.engine.deliver(event({ name: "pair.activated" }));
    const instances = await w.engine.instances();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.state).toEqual({ name: "armed", reminded: false });
    expect(instances[0]!.timeoutAt).toBe(DUE);
    expect(w.calls.map((c) => c.type)).toEqual(["post_message"]);
  });

  // Found by the dm-outage-no-thread journey: the booking step emits
  // `session.scheduled` and then fails on the booked confirmation. The relay
  // delivers that event while the instance still waits on the step's input,
  // and matching only `awaitingEvent` dropped it — the saga later sat in
  // `scheduling` until it paused `calendar_never_confirmed` on a booked session.
  it("an event a failed step emitted wakes it: the step is finished, then the event is taken", async () => {
    type S = { name: "proposing" } | { name: "scheduling" } | { name: "armed" };
    const booking: Saga<S> = {
      name: "Booking",
      initial: () => ({ name: "proposing" }),
      step(state, input, ctx) {
        if (state.name === "proposing" && input.kind === "start") {
          return {
            next: state,
            waitFor: { names: ["agreement.responded"], subjectRef: ctx.subjectRef },
            timeoutAt: DUE,
          };
        }
        if (state.name === "proposing") {
          return {
            next: { name: "scheduling" },
            waitFor: { names: ["session.scheduled"], subjectRef: ctx.subjectRef },
            timeoutAt: DUE,
            effects: [
              { type: "emit", name: "session.scheduled" },
              { type: "post_message", body: "booked" },
            ],
          };
        }
        if (state.name === "scheduling" && input.kind === "event") {
          return { next: { name: "armed" }, done: true };
        }
        return { next: state, done: true };
      },
    };
    const w = recordingWorld(booking, {
      fail: (effect, ctx) => effect.type === "post_message" && ctx.attempt === 0,
    });
    await w.engine.start({ sagaName: "Booking", orgId: "org_1", subjectRef: "pairing:p1" });
    await expect(
      w.engine.deliver(event({ id: "evt_resp", name: "agreement.responded" })),
    ).rejects.toThrow("post_message outage");

    await w.engine.deliver(event({ id: "evt_sched", name: "session.scheduled" }));
    const instance = await w.only();
    expect(instance.state).toEqual({ name: "armed" });
    expect(w.calls.map((c) => c.type)).toEqual(["emit", "post_message"]);
  });
});
