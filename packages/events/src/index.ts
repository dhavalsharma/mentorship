import type { DomainEvent, EventName, IdFactory } from "@mentorship/core";
import { uuidIds } from "@mentorship/core";

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface EmitInput {
  orgId: string;
  name: EventName;
  subjectRef: string;
  payload?: Record<string, unknown>;
}

/**
 * What a producer needs: somewhere to append an event. `EventLog` is the
 * in-memory implementation; in Postgres it is a row in `events` written in the
 * same transaction as the state change, drained by the relay. The effect
 * runner depends on this rather than on the class, so the same saga code runs
 * against either.
 */
export interface EventSink {
  emit(input: EmitInput): Promise<DomainEvent>;
}

export interface DeadLetter {
  event: DomainEvent;
  error: string;
  at: string;
}

/**
 * The append-only log plus a synchronous fan-out.
 *
 * PRODUCTION NOTE: in Postgres this is an `events` table written in the same
 * transaction as the state change (transactional outbox), with a relay process
 * doing the fan-out. A handler that throws is retried with backoff and then
 * parked — it must never block the producer, which is why failures land in
 * `deadLetters` here rather than propagating to the caller.
 */
export class EventLog implements EventSink {
  private handlers: EventHandler[] = [];
  private readonly events: DomainEvent[] = [];
  readonly deadLetters: DeadLetter[] = [];

  constructor(
    private readonly ids: IdFactory = uuidIds,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  async emit(input: EmitInput): Promise<DomainEvent> {
    const event: DomainEvent = {
      id: this.ids.next("evt"),
      orgId: input.orgId,
      name: input.name,
      subjectRef: input.subjectRef,
      occurredAt: this.clock().toISOString(),
      version: 1,
      payload: input.payload ?? {},
    };
    this.events.push(event);

    for (const handler of [...this.handlers]) {
      try {
        await handler(event);
      } catch (error) {
        this.deadLetters.push({
          event,
          error: error instanceof Error ? error.message : String(error),
          at: this.clock().toISOString(),
        });
      }
    }
    return event;
  }

  all(): readonly DomainEvent[] {
    return this.events;
  }

  /** Replay is why a primitive written in month four can be backfilled. */
  async replay(handler: EventHandler): Promise<void> {
    for (const event of this.events) await handler(event);
  }
}
