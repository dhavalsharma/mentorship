import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { DomainEvent } from "@mentorship/core";
import { events, withTenant, type Db } from "@mentorship/db";
import type { EmitInput, EventSink } from "@mentorship/events";

/**
 * The producing half of the outbox: an event becomes a row, and the relay
 * drains it later. Nothing is fanned out here.
 *
 * That delay is the design, not a limitation. An effect emitting an event that
 * immediately re-entered the engine would land inside the transition that
 * produced it and corrupt the version check — the same reason the in-memory
 * `Dispatcher` queues instead of delivering inline.
 */
export class PostgresEventSink implements EventSink {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string; now?: () => Date } = {},
  ) {}

  async emit(input: EmitInput): Promise<DomainEvent> {
    const occurredAt = this.options.now?.() ?? new Date();
    const { role } = this.options;

    const row = await withTenant(
      this.db,
      input.orgId,
      async (tx) => {
        const key = input.idempotencyKey ?? null;
        const insert = tx.insert(events).values({
          orgId: input.orgId,
          name: input.name,
          subjectRef: input.subjectRef,
          payload: input.payload ?? {},
          occurredAt,
          idempotencyKey: key,
        });
        // Keyed: a retried effect's second emit lands on the partial unique
        // index (migration 0014) and inserts nothing. Targeted at that index
        // only, so any *other* uniqueness violation (the notes dedupe, 0011)
        // still surfaces rather than being silently absorbed here.
        const [inserted] = await (key === null
          ? insert
          : insert.onConflictDoNothing({
              target: [events.orgId, events.idempotencyKey],
              where: sql`${events.idempotencyKey} IS NOT NULL`,
            })
        ).returning();
        if (inserted) return inserted;
        if (key !== null) {
          // The row the first attempt committed. Returned rather than thrown
          // so the retried effect reads back the ids it minted last time.
          const [existing] = await tx
            .select()
            .from(events)
            .where(
              and(
                eq(events.orgId, input.orgId),
                isNotNull(events.idempotencyKey),
                eq(events.idempotencyKey, key),
              ),
            )
            .limit(1);
          if (existing) return existing;
        }
        throw new Error(`failed to append ${input.name}`);
      },
      role === undefined ? {} : { role },
    );

    return {
      id: row.id,
      orgId: row.orgId,
      name: row.name as DomainEvent["name"],
      subjectRef: row.subjectRef,
      occurredAt: row.occurredAt.toISOString(),
      version: row.version,
      payload: row.payload as Record<string, unknown>,
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    };
  }
}
