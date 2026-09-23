import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, organizations } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { PostgresEventSink } from "@mentorship/workflows/postgres";

/**
 * Bug #6 in docs/e2e-testing-strategy.md, at the database: a keyed emit is
 * appended once however many times it is retried, including concurrently —
 * the partial unique index from migration 0014, not a SELECT-then-INSERT.
 * The in-memory parity half is emit-idempotency.test.ts. Skipped without
 * DATABASE_URL.
 */

describe.skipIf(!DATABASE_URL)("PostgresEventSink — idempotency key", () => {
  let handle: TestDb;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();

  beforeAll(async () => {
    handle = await connectTestDb();
    await handle.db.insert(organizations).values([
      { id: orgId, name: "Emit", slug: `emit-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Emit2", slug: `emit-${otherOrgId.slice(0, 8)}` },
    ]);
  });

  afterAll(async () => {
    if (!handle) return;
    for (const id of [orgId, otherOrgId]) {
      await handle.db.delete(events).where(eq(events.orgId, id));
      await handle.db.delete(organizations).where(eq(organizations.id, id));
    }
    await handle.close();
  });

  const rows = (org: string, name: string) =>
    handle.db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org), eq(events.name, name)));

  it("a repeated key inserts nothing and returns the row already there, under RLS", async () => {
    const sink = new PostgresEventSink(handle.db, { role: "mentorship_app" });
    const input = {
      orgId,
      name: "session.scheduled" as const,
      subjectRef: `pairing:${randomUUID()}`,
      payload: { sessionId: "first" },
      idempotencyKey: `saga_${randomUUID()}:4:0:session.scheduled`,
    };
    const first = await sink.emit(input);
    const second = await sink.emit({ ...input, payload: { sessionId: "second" } });

    expect(second.id).toBe(first.id);
    expect(second.payload["sessionId"]).toBe("first");
    expect(await rows(orgId, "session.scheduled")).toHaveLength(1);
  });

  it("two concurrent writers with one key still produce one row", async () => {
    const sink = new PostgresEventSink(handle.db, { role: "mentorship_app" });
    const input = {
      orgId,
      name: "pair.cadence_deficit" as const,
      subjectRef: `pairing:${randomUUID()}`,
      idempotencyKey: `saga_${randomUUID()}:9:0:pair.cadence_deficit`,
    };
    const results = await Promise.all([sink.emit(input), sink.emit(input), sink.emit(input)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await rows(orgId, "pair.cadence_deficit")).toHaveLength(1);
  });

  it("scopes the key by org, and leaves unkeyed events free to repeat", async () => {
    const sink = new PostgresEventSink(handle.db, { role: "mentorship_app" });
    const key = `saga_${randomUUID()}:2:0:session.held`;
    const base = { name: "session.held" as const, subjectRef: `pairing:${randomUUID()}` };
    await sink.emit({ ...base, orgId, idempotencyKey: key });
    await sink.emit({ ...base, orgId: otherOrgId, idempotencyKey: key });
    await sink.emit({ ...base, orgId });
    await sink.emit({ ...base, orgId });
    expect(await rows(orgId, "session.held")).toHaveLength(3);
    expect(await rows(otherOrgId, "session.held")).toHaveLength(1);
  });
});
