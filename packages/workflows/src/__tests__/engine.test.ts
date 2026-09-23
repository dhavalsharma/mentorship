import { describe, expect, it, vi } from "vitest";
import {
  sequentialIds,
  type DomainEvent,
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
    expect(instance.version).toBe(1);
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

  it("survives a lost version race by yielding to the winner", async () => {
    const inner = new MemorySagaStore();
    let failNext = true;
    const flaky: SagaStore = {
      create: (i) => inner.create(i),
      get: (id) => inner.get(id),
      findAwaiting: (e) => inner.findAwaiting(e),
      findDue: (n) => inner.findDue(n),
      findBySubject: (s, r) => inner.findBySubject(s, r),
      list: () => inner.list(),
      async save(instance: SagaInstance, expected: number) {
        if (failNext) {
          failNext = false;
          throw new SagaConflictError(instance.id, expected, expected + 1);
        }
        return inner.save(instance, expected);
      },
    };

    const { engine, ran } = harness(flaky);
    const instance = await engine.start({
      sagaName: "Tiny",
      orgId: "org_1",
      subjectRef: "pairing:p1",
    });
    // The conflict is swallowed, the caller gets the stored row back, and the
    // effect ran exactly once rather than being retried into a duplicate.
    expect(instance.state).toEqual({ name: "start" });
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
