import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@mentorship/core";
import { events, organizations } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { relayOnce, type EventDeliverer } from "@mentorship/workflows/postgres";

/**
 * The relay is the difference between a recorded click and a saga that moves,
 * so the cases that matter are the unhappy ones: a subscriber that throws must
 * not block the events behind it, must not be retried forever, and two relay
 * workers must not both deliver the same event.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

describe.skipIf(!DATABASE_URL)("the outbox relay", () => {
  let handle: TestDb;
  const orgId = randomUUID();

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db
      .insert(organizations)
      .values({ id: orgId, name: "Relay", slug: `relay-${orgId.slice(0, 8)}` });
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(events).where(eq(events.orgId, orgId));
    await handle.db.delete(organizations).where(eq(organizations.id, orgId));
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.delete(events).where(eq(events.orgId, orgId));
  });

  async function seed(
    name: string,
    occurredAt: string,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await handle.db
      .insert(events)
      .values({
        orgId,
        name,
        subjectRef: `pairing:${randomUUID()}`,
        occurredAt: new Date(occurredAt),
        payload,
      })
      .returning();
    return row!.id;
  }

  function recorder(): EventDeliverer & { seen: DomainEvent[] } {
    const seen: DomainEvent[] = [];
    return {
      seen,
      async deliver(event) {
        seen.push(event);
        return 1;
      },
    };
  }

  it("delivers pending events oldest first and marks them relayed", async () => {
    await seed("session.held", "2026-09-02T10:00:00.000Z");
    await seed("pair.activated", "2026-09-01T10:00:00.000Z");
    await seed("feedback.submitted", "2026-09-03T10:00:00.000Z");

    const engine = recorder();
    const result = await relayOnce(handle.db, engine);

    expect(result).toEqual({ delivered: 3, failed: 0, deadLettered: 0 });
    expect(engine.seen.map((e) => e.name)).toEqual([
      "pair.activated",
      "session.held",
      "feedback.submitted",
    ]);

    const rows = await handle.db.select().from(events).where(eq(events.orgId, orgId));
    expect(rows.every((r) => r.relayedAt !== null)).toBe(true);
  });

  it("carries the payload through intact", async () => {
    await seed("agreement.responded", "2026-09-01T10:00:00.000Z", {
      agreementId: "a1",
      optionId: "opt_2",
      nested: { deep: [1, 2, 3] },
    });
    const engine = recorder();
    await relayOnce(handle.db, engine);
    expect(engine.seen[0]!.payload).toEqual({
      agreementId: "a1",
      optionId: "opt_2",
      nested: { deep: [1, 2, 3] },
    });
  });

  it("does not deliver an event twice", async () => {
    await seed("pair.activated", "2026-09-01T10:00:00.000Z");
    const engine = recorder();

    await relayOnce(handle.db, engine);
    await relayOnce(handle.db, engine);

    expect(engine.seen).toHaveLength(1);
  });

  it("retries a failure with backoff instead of blocking the queue", async () => {
    const poison = await seed("pair.activated", "2026-09-01T10:00:00.000Z");
    await seed("session.held", "2026-09-02T10:00:00.000Z");

    const at = new Date("2026-09-10T00:00:00.000Z");
    const engine: EventDeliverer = {
      async deliver(event) {
        if (event.id === poison) throw new Error("subscriber exploded");
        return 1;
      },
    };

    const result = await relayOnce(handle.db, engine, { now: () => at });
    expect(result).toEqual({ delivered: 1, failed: 1, deadLettered: 0 });

    const [row] = await handle.db.select().from(events).where(eq(events.id, poison));
    expect(row!.attempts).toBe(1);
    expect(row!.relayedAt).toBeNull();
    expect(row!.lastError).toMatch(/subscriber exploded/);
    // Backed off rather than retried immediately, and not yet parked.
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(at.getTime());
    expect(row!.deadLetteredAt).toBeNull();
  });

  it("leaves a backed-off event alone until its time comes", async () => {
    const poison = await seed("pair.activated", "2026-09-01T10:00:00.000Z");
    const engine: EventDeliverer = {
      async deliver() {
        throw new Error("still broken");
      },
    };
    const at = new Date("2026-09-10T00:00:00.000Z");
    await relayOnce(handle.db, engine, { now: () => at });

    // A second pass one second later must not touch it.
    const soon = new Date(at.getTime() + 1000);
    const result = await relayOnce(handle.db, engine, { now: () => soon });
    expect(result).toEqual({ delivered: 0, failed: 0, deadLettered: 0 });

    const [row] = await handle.db.select().from(events).where(eq(events.id, poison));
    expect(row!.attempts).toBe(1);
  });

  it("parks an event after maxAttempts rather than retrying it forever", async () => {
    const poison = await seed("pair.activated", "2026-09-01T10:00:00.000Z");
    const engine: EventDeliverer = {
      async deliver() {
        throw new Error("permanently broken");
      },
    };

    // Each pass moves the clock past the previous backoff.
    let at = new Date("2026-09-10T00:00:00.000Z");
    const parked: DomainEvent[] = [];
    for (let i = 0; i < 3; i++) {
      await relayOnce(handle.db, engine, {
        now: () => at,
        maxAttempts: 3,
        onDeadLettered: (event) => parked.push(event),
      });
      at = new Date(at.getTime() + 60 * 60 * 1000);
    }

    expect(parked).toHaveLength(1);
    const [row] = await handle.db.select().from(events).where(eq(events.id, poison));
    expect(row!.attempts).toBe(3);
    expect(row!.deadLetteredAt).not.toBeNull();
    expect(row!.nextAttemptAt).toBeNull();

    // And a parked event is never picked up again.
    const after = await relayOnce(handle.db, engine, {
      now: () => new Date("2027-01-01T00:00:00.000Z"),
      maxAttempts: 3,
    });
    expect(after).toEqual({ delivered: 0, failed: 0, deadLettered: 0 });
  });

  it("gives each event to exactly one of two concurrent relays", async () => {
    for (let i = 0; i < 8; i++) {
      await seed("session.held", `2026-09-0${i + 1}T10:00:00.000Z`);
    }

    // Both start at once and race for the same rows; SKIP LOCKED is what stops
    // them from both delivering one — the duplicate a saga would then have to
    // absorb.
    const a = recorder();
    const b = recorder();
    const [ra, rb] = await Promise.all([
      relayOnce(handle.db, a),
      relayOnce(handle.db, b),
    ]);

    expect(ra.delivered + rb.delivered).toBe(8);
    const ids = [...a.seen, ...b.seen].map((e) => e.id);
    expect(new Set(ids).size).toBe(8);
  });

  it("stops at the batch size", async () => {
    for (let i = 0; i < 5; i++) {
      await seed("session.held", `2026-09-0${i + 1}T10:00:00.000Z`);
    }
    const engine = recorder();
    const result = await relayOnce(handle.db, engine, { batchSize: 2 });
    expect(result.delivered).toBe(2);
    expect(engine.seen).toHaveLength(2);
  });

  it("reports nothing to do on an empty outbox", async () => {
    const engine = recorder();
    expect(await relayOnce(handle.db, engine)).toEqual({
      delivered: 0,
      failed: 0,
      deadLettered: 0,
    });
  });
});
