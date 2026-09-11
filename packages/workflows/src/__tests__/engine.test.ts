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
    expect(await engine.tick()).toBe(0);

    const later = new SagaEngine({
      store,
      runEffect: async () => null,
      resolvers: noResolvers,
      now: () => new Date("2026-09-13T06:00:00.000Z"),
    });
    later.register(tinySaga());
    expect(await later.tick()).toBe(1);
    const [instance] = await later.instances();
    expect(instance!.status).toBe("done");
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
