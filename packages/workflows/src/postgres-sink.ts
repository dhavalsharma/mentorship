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
        const [inserted] = await tx
          .insert(events)
          .values({
            orgId: input.orgId,
            name: input.name,
            subjectRef: input.subjectRef,
            payload: input.payload ?? {},
            occurredAt,
          })
          .returning();
        if (!inserted) throw new Error(`failed to append ${input.name}`);
        return inserted;
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
    };
  }
}
