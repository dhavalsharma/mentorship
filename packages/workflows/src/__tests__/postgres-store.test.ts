import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent, SagaInstance } from "@mentorship/core";
import { organizations, sagaInstances } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { MemorySagaStore, SagaConflictError, type SagaStore } from "@mentorship/workflows";
import { PostgresSagaStore } from "@mentorship/workflows/postgres";

/**
 * The Postgres store has to behave exactly like the memory store the whole
 * test suite and the demo run on, or every guarantee proved against the
 * memory one is proved about the wrong thing. So the interesting cases run
 * against both, and the Postgres-only concerns (uuid ids, a real racing
 * UPDATE) get their own tests.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

describe.skipIf(!DATABASE_URL)("PostgresSagaStore", () => {
  let handle: TestDb;
  let store: PostgresSagaStore;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const created: string[] = [];

  beforeAll(async () => {
    handle = await connectTestDb();
    store = new PostgresSagaStore(handle.db);
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Store Org", slug: `store-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Other", slug: `other-${otherOrgId.slice(0, 8)}` },
    ]);
  });

  afterAll(async () => {
    if (!handle) return;
    if (created.length > 0) {
      await handle.db.delete(sagaInstances).where(inArray(sagaInstances.id, created));
    }
    await handle.db
      .delete(organizations)
      .where(inArray(organizations.id, [orgId, otherOrgId]));
    await handle.close();
  });

  function instance(over: Partial<SagaInstance> = {}): SagaInstance {
    const id = randomUUID();
    created.push(id);
    return {
      id,
      orgId,
      sagaName: "SessionLifecycle",
      subjectRef: `pairing:${randomUUID()}`,
      state: { name: "proposing", round: 1 },
      awaitingEvent: { names: ["agreement.responded"], subjectRef: "agreement:x" },
      timeoutAt: null,
      version: 0,
      stepIndex: 0,
      completedEffects: {},
      history: [],
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    };
  }

  it("round-trips every field", async () => {
    const original = instance({
      timeoutAt: new Date("2026-10-01T09:00:00.000Z").toISOString(),
      completedEffects: { "saga:1:0:0": { messageRef: "m1" } },
      history: [
        {
          at: "2026-09-15T10:00:00.000Z",
          stepIndex: 0,
          input: "start",
          from: "idle",
          to: "proposing",
          effects: ["post_proposal"],
        },
      ],
    });
    await store.create(original);

    const loaded = await store.get(original.id);
    expect(loaded).toEqual(original);
  });

  it("rejects a duplicate id the way the memory store does", async () => {
    const one = instance();
    await store.create(one);
    await expect(store.create(one)).rejects.toThrow(/already exists/);
  });

  it("returns null for an unknown id", async () => {
    expect(await store.get(randomUUID())).toBeNull();
  });

  it("saves at the expected version and rejects a stale write", async () => {
    const original = instance();
    await store.create(original);

    const saved = await store.save(
      { ...original, version: 1, stepIndex: 1, state: { name: "scheduling" } },
      0,
    );
    expect(saved.version).toBe(1);
    expect(saved.state).toEqual({ name: "scheduling" });

    // Another writer already moved it on; this one must lose rather than merge.
    await expect(
      store.save({ ...original, version: 1, state: { name: "armed" } }, 0),
    ).rejects.toBeInstanceOf(SagaConflictError);

    const after = await store.get(original.id);
    expect(after?.state).toEqual({ name: "scheduling" });
  });

  it("lets exactly one of two concurrent writers win", async () => {
    const original = instance();
    await store.create(original);

    const results = await Promise.allSettled([
      store.save({ ...original, version: 1, state: { name: "a" } }, 0),
      store.save({ ...original, version: 1, state: { name: "b" } }, 0),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
  });

  it("reports a missing row differently from a conflict", async () => {
    await expect(store.save(instance({ version: 1 }), 0)).rejects.toThrow(
      /not found/,
    );
  });

  it("wakes only sagas awaiting that event, in that org", async () => {
    const subject = `agreement:${randomUUID()}`;
    const waiting = instance({
      awaitingEvent: { names: ["agreement.responded"], subjectRef: subject },
    });
    const wrongSubject = instance({
      awaitingEvent: { names: ["agreement.responded"], subjectRef: "agreement:other" },
    });
    const wrongName = instance({
      awaitingEvent: { names: ["session.held"], subjectRef: subject },
    });
    const wrongOrg = instance({
      orgId: otherOrgId,
      awaitingEvent: { names: ["agreement.responded"], subjectRef: subject },
    });
    const finished = instance({
      status: "done",
      awaitingEvent: { names: ["agreement.responded"], subjectRef: subject },
    });
    for (const i of [waiting, wrongSubject, wrongName, wrongOrg, finished]) {
      await store.create(i);
    }

    const woken = await store.findAwaiting(event(orgId, "agreement.responded", subject));
    expect(woken.map((i) => i.id)).toEqual([waiting.id]);
  });

  it("finds only timers that are actually due", async () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    const due = instance({
      timeoutAt: new Date("2026-10-31T23:59:00.000Z").toISOString(),
      subjectRef: `pairing:${randomUUID()}`,
    });
    const notYet = instance({
      timeoutAt: new Date("2026-11-01T00:01:00.000Z").toISOString(),
    });
    const noTimer = instance({ timeoutAt: null });
    for (const i of [due, notYet, noTimer]) await store.create(i);

    const ids = (await store.findDue(now)).map((i) => i.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(notYet.id);
    expect(ids).not.toContain(noTimer.id);
  });

  it("scopes findDue to one org when asked, leaving another org's due instance for its own worker", async () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    const dueHere = instance({
      timeoutAt: new Date("2026-10-31T23:59:00.000Z").toISOString(),
    });
    const dueElsewhere = instance({
      orgId: otherOrgId,
      timeoutAt: new Date("2026-10-31T23:59:00.000Z").toISOString(),
    });
    for (const i of [dueHere, dueElsewhere]) await store.create(i);

    const ids = (await store.findDue(now, orgId)).map((i) => i.id);
    expect(ids).toContain(dueHere.id);
    expect(ids).not.toContain(dueElsewhere.id);
  });

  it("finds an instance by saga name and subject", async () => {
    const original = instance();
    await store.create(original);
    const found = await store.findBySubject("SessionLifecycle", original.subjectRef);
    expect(found?.id).toBe(original.id);
    expect(await store.findBySubject("Other", original.subjectRef)).toBeNull();
  });

  it("names the fix when an id is not a bare uuid", async () => {
    // `uuidIds` produces `sga_<uuid>` and `sequentialIds` produces `sga_001`.
    await expect(store.create(instance({ id: "sga_001" }))).rejects.toThrow(
      /bareUuidIds/,
    );
  });
});

/**
 * The same assertions against both stores. Anything that passes here and fails
 * in production is a difference this test was supposed to have caught.
 */
describe.skipIf(!DATABASE_URL)("memory and Postgres stores agree", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const ids: string[] = [];

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Parity", slug: `parity-${orgId.slice(0, 8)}` });
  });

  afterAll(async () => {
    if (!handle) return;
    if (ids.length > 0) {
      await handle.db.delete(sagaInstances).where(inArray(sagaInstances.id, ids));
    }
    await handle.db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await handle.close();
  });

  async function bothStores(): Promise<[string, SagaStore][]> {
    return [
      ["memory", new MemorySagaStore()],
      ["postgres", new PostgresSagaStore(handle.db)],
    ];
  }

  it("agrees on create, save, conflict and findAwaiting", async () => {
    for (const [name, store] of await bothStores()) {
      const id = randomUUID();
      ids.push(id);
      const subject = `agreement:${randomUUID()}`;
      const base: SagaInstance = {
        id,
        orgId,
        sagaName: "SessionLifecycle",
        subjectRef: `pairing:${randomUUID()}`,
        state: { name: "proposing" },
        awaitingEvent: { names: ["agreement.responded"], subjectRef: subject },
        timeoutAt: null,
        version: 0,
        stepIndex: 0,
        completedEffects: {},
        history: [],
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect((await store.create(base)).id, name).toBe(id);
      expect((await store.get(id))?.version, name).toBe(0);

      const saved = await store.save({ ...base, version: 1 }, 0);
      expect(saved.version, name).toBe(1);

      await expect(store.save({ ...base, version: 2 }, 0)).rejects.toBeInstanceOf(
        SagaConflictError,
      );

      const woken = await store.findAwaiting(
        event(orgId, "agreement.responded", subject),
      );
      expect(woken.map((i) => i.id).includes(id), name).toBe(true);

      const missed = await store.findAwaiting(
        event(orgId, "agreement.responded", "agreement:nope"),
      );
      expect(missed.map((i) => i.id).includes(id), name).toBe(false);
    }
  });
});

function event(orgId: string, name: string, subjectRef: string): DomainEvent {
  return {
    id: randomUUID(),
    orgId,
    name: name as DomainEvent["name"],
    subjectRef,
    occurredAt: new Date().toISOString(),
    version: 1,
    payload: {},
  };
}
