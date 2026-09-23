import { describe, expect, it, vi } from "vitest";
import {
  sequentialIds,
  type Effect,
  type PairContext,
  type SagaInstance,
  type SagaResolvers,
} from "@mentorship/core";
import { EventLog } from "@mentorship/events";
import {
  FakeCalendar,
  IntegrationRegistry,
  Recorder,
} from "@mentorship/integrations";
import { createEffectRunner, heuristicSessionIntel } from "@mentorship/workflows";

/**
 * Bug #6 in docs/e2e-testing-strategy.md: an `emit` — or a runner emit inside
 * an effect, like `session.scheduled` after `createEvent` — committed on its
 * own, before the step's completed-effect ledger was saved. A step retried
 * after a crash re-ran it and appended the event twice. Every effect-produced
 * event is now keyed by its effect key, and both sinks treat a repeat as "the
 * event you already appended" (invariant 6). The Postgres half — the sink and
 * the projector — is in postgres-sink.test.ts / postgres-projector.test.ts,
 * because the dependency rule keeps db imports out of every other file here.
 */

const NOW = new Date("2026-09-11T06:00:00.000Z");

describe("EventLog — idempotency key", () => {
  it("appends a keyed event once, returns the original and fans out once", async () => {
    const log = new EventLog(sequentialIds(), () => NOW);
    const seen: string[] = [];
    log.on((e) => void seen.push(e.id));

    const input = {
      orgId: "org_1",
      name: "session.held" as const,
      subjectRef: "pairing:p1",
      idempotencyKey: "saga_1:3:0:session.held",
    };
    const first = await log.emit(input);
    const second = await log.emit({ ...input, payload: { different: true } });

    expect(second).toBe(first);
    expect(log.all()).toHaveLength(1);
    expect(seen).toEqual([first.id]);
  });

  it("scopes keys by org, and leaves unkeyed events free to repeat", async () => {
    const log = new EventLog(sequentialIds(), () => NOW);
    const base = { name: "session.held" as const, subjectRef: "pairing:p1" };
    await log.emit({ ...base, orgId: "org_1", idempotencyKey: "k" });
    await log.emit({ ...base, orgId: "org_2", idempotencyKey: "k" });
    await log.emit({ ...base, orgId: "org_1" });
    await log.emit({ ...base, orgId: "org_1" });
    expect(log.all()).toHaveLength(4);
  });
});

describe("createEffectRunner — a retried effect does not re-emit", () => {
  const pair = {
    orgId: "org_1",
    pairingId: "p1",
    title: "Ada & Grace",
    participants: [
      { participantId: "a", memberRef: "U1", calendarRef: "ada@example.com", email: "ada@example.com" },
      { participantId: "b", memberRef: "U2", calendarRef: "grace@example.com", email: "grace@example.com" },
    ],
  } as unknown as PairContext;

  const resolvers = {
    pairContext: vi.fn(async () => pair),
    freeBusy: vi.fn(),
    agreement: vi.fn(),
    capabilities: vi.fn(),
  } as unknown as SagaResolvers;

  const instance = {
    id: "saga_1",
    orgId: "org_1",
    subjectRef: "pairing:p1",
  } as unknown as SagaInstance;

  function setup(withCalendar: boolean) {
    const ids = sequentialIds();
    const log = new EventLog(ids, () => NOW);
    const recorder = new Recorder();
    const registry = new IntegrationRegistry();
    if (withCalendar) registry.bind(new FakeCalendar(recorder));
    const run = createEffectRunner({
      registry,
      log,
      resolvers,
      intel: heuristicSessionIntel(ids),
      ids,
    });
    return { log, recorder, run };
  }

  const book: Effect = {
    type: "create_calendar_event",
    start: "2026-09-15T15:00:00.000Z",
    end: "2026-09-15T15:45:00.000Z",
    title: "Mentoring",
    description: "",
    withConference: true,
    withTranscription: false,
  };

  for (const withCalendar of [true, false]) {
    it(`create_calendar_event (${withCalendar ? "calendar bound" : "degraded"}): one session.scheduled, the same sessionId back`, async () => {
      const { log, run } = setup(withCalendar);
      const ctx = { instance, key: "saga_1:4:0", now: NOW, attempt: 0 };

      // The crash: the first attempt ran and emitted, the step never saved,
      // so the retry runs the same effect under the same key.
      const first = (await run(book, ctx)) as { sessionId: string };
      const second = (await run(book, ctx)) as { sessionId: string };

      const scheduled = log.all().filter((e) => e.name === "session.scheduled");
      expect(scheduled).toHaveLength(1);
      expect(second.sessionId).toBe(first.sessionId);
      expect(scheduled[0]!.payload["sessionId"]).toBe(first.sessionId);
    });
  }

  it("emit: the same key twice is one event and one eventId", async () => {
    const { log, run } = setup(true);
    const ctx = { instance, key: "saga_1:7:1", now: NOW, attempt: 0 };
    const effect: Effect = { type: "emit", name: "pair.cadence_deficit" };
    const a = (await run(effect, ctx)) as { eventId: string };
    const b = (await run(effect, ctx)) as { eventId: string };
    expect(b.eventId).toBe(a.eventId);
    expect(log.all().filter((e) => e.name === "pair.cadence_deficit")).toHaveLength(1);
  });

  it("a different step is a different key, so a real second emit still lands", async () => {
    const { log, run } = setup(true);
    const effect: Effect = { type: "emit", name: "session.held" };
    await run(effect, { instance, key: "saga_1:5:0", now: NOW, attempt: 0 });
    await run(effect, { instance, key: "saga_1:9:0", now: NOW, attempt: 0 });
    expect(log.all().filter((e) => e.name === "session.held")).toHaveLength(2);
  });
});
