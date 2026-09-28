import type { DomainEvent, EventName, IdFactory } from "@mentorship/core";
import { uuidIds } from "@mentorship/core";

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface EmitInput {
  orgId: string;
  name: EventName;
  subjectRef: string;
  payload?: Record<string, unknown>;
  /**
   * Set by the effect runner for an event a saga effect produced: the
   * effect's key (`saga:{id}:{step}:{index}`) plus the event name. A second
   * emit with the same key in the same org is a no-op that returns the event
   * already appended — not a second event, and not an error. That is what
   * keeps an emit idempotent across a step retried after a crash (invariant
   * 6), where the engine's completed-effect ledger cannot help: it is saved
   * with the step, and the event was committed before the step was.
   */
  idempotencyKey?: string;
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
  /** Parity with `events_idempotency_key_unique` on Postgres (migration 0014). */
  private readonly byKey = new Map<string, DomainEvent>();
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
    const dedupe =
      input.idempotencyKey === undefined
        ? undefined
        : `${input.orgId}\u0000${input.idempotencyKey}`;
    if (dedupe !== undefined) {
      // Already appended: hand back the original and fan nothing out. A
      // handler seeing it twice is exactly the duplicate this key prevents.
      const seen = this.byKey.get(dedupe);
      if (seen) return seen;
    }
    const event: DomainEvent = {
      id: this.ids.next("evt"),
      orgId: input.orgId,
      name: input.name,
      subjectRef: input.subjectRef,
      occurredAt: this.clock().toISOString(),
      version: 1,
      payload: input.payload ?? {},
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    this.events.push(event);
    if (dedupe !== undefined) this.byKey.set(dedupe, event);

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
