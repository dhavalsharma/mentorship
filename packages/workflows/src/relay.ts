import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { DomainEvent } from "@mentorship/core";
import { events, type Db } from "@mentorship/db";

/**
 * The outbox relay: the thing that turns a row in `events` into a saga that
 * moves. Without it a Slack click is durably recorded and nothing happens.
 *
 * Delivery is **at-least-once**, deliberately. Effects reach the outside world
 * — a calendar invite, a Slack message — and no transaction can roll those
 * back, so the alternative is at-most-once, which loses them. Duplicates are
 * absorbed by the two mechanisms that already exist for it: the engine's
 * completed-effect ledger (invariant 6), and `findAwaiting` matching on the
 * instance's *current* pattern, so an event redelivered after the saga has
 * moved on matches nothing.
 *
 * A claimed row stays locked for the duration of its delivery. That is a long
 * transaction by the usual standard, and it is the right trade here: it needs
 * no `claimed_at` column, no lease expiry, and no sweeper for rows abandoned
 * by a crashed worker — the lock simply dies with the connection and the row
 * is picked up again. `SKIP LOCKED` is what lets a second worker get on with
 * other events instead of queueing behind this one.
 */

export interface RelayOptions {
  /**
   * Drain only this organisation's events. A worker built for one tenant has
   * tenant-scoped resolvers, so handing it another org's event would resolve
   * the wrong pairing — or throw. A relay that genuinely serves every tenant
   * leaves this unset and must construct its resolvers per event.
   */
  orgId?: string;
  /** How many events to deliver before returning. */
  batchSize?: number;
  /** Attempts before the event is parked rather than retried forever. */
  maxAttempts?: number;
  /** Backoff for attempt n, in milliseconds. */
  backoffMs?: (attempt: number) => number;
  now?: () => Date;
  /**
   * Read-model projections, applied before the engine sees the event. They run
   * in their own committed transaction rather than the relay's, because the
   * engine reads on a different connection and would not see an uncommitted
   * row — which is also why they have to be idempotent.
   */
  project?: (event: DomainEvent) => Promise<void>;
  onDelivered?: (event: DomainEvent, advanced: number) => void;
  onFailed?: (event: DomainEvent, error: Error, attempts: number) => void;
  onDeadLettered?: (event: DomainEvent, error: Error) => void;
}

export interface RelayResult {
  delivered: number;
  failed: number;
  deadLettered: number;
}

/** What the relay needs from the engine — `SagaEngine.deliver` satisfies it. */
export interface EventDeliverer {
  deliver(event: DomainEvent): Promise<number>;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/** 1s, 4s, 16s, 64s… — long enough to outlast a restart, short enough to notice. */
const defaultBackoff = (attempt: number): number =>
  Math.min(4 ** attempt * 1000, 15 * 60 * 1000);

export async function relayOnce(
  db: Db,
  engine: EventDeliverer,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? defaultBackoff;
  const now = options.now ?? (() => new Date());

  const result: RelayResult = { delivered: 0, failed: 0, deadLettered: 0 };

  for (let i = 0; i < batchSize; i++) {
    const moved = await db.transaction(async (tx) => {
      const at = now();
      const [row] = await tx
        .select()
        .from(events)
        .where(
          // Built with drizzle's operators rather than a raw `sql` template:
          // a template binds a JS Date straight to the driver, skipping the
          // column's type mapping, and postgres-js rejects it.
          and(
            ...(options.orgId ? [eq(events.orgId, options.orgId)] : []),
            isNull(events.relayedAt),
            isNull(events.deadLetteredAt),
            or(isNull(events.nextAttemptAt), lte(events.nextAttemptAt, at)),
          ),
        )
        .orderBy(events.occurredAt)
        .limit(1)
        .for("update", { skipLocked: true });

      if (!row) return false;

      const event: DomainEvent = {
        id: row.id,
        orgId: row.orgId,
        name: row.name as DomainEvent["name"],
        subjectRef: row.subjectRef,
        occurredAt: row.occurredAt.toISOString(),
        version: row.version,
        payload: row.payload as Record<string, unknown>,
      };

      try {
        await options.project?.(event);
        const advanced = await engine.deliver(event);
        await tx
          .update(events)
          .set({ relayedAt: at, lastError: null })
          .where(eq(events.id, row.id));
        result.delivered++;
        options.onDelivered?.(event, advanced);
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        const attempts = row.attempts + 1;
        const parked = attempts >= maxAttempts;

        // The failure is recorded on the row, not thrown: one poisonous event
        // must never stop the ones behind it.
        await tx
          .update(events)
          .set({
            attempts,
            lastError: error.message.slice(0, 2000),
            nextAttemptAt: parked
              ? null
              : new Date(at.getTime() + backoff(attempts)),
            deadLetteredAt: parked ? at : null,
          })
          .where(eq(events.id, row.id));

        if (parked) {
          result.deadLettered++;
          options.onDeadLettered?.(event, error);
        } else {
          result.failed++;
          options.onFailed?.(event, error, attempts);
        }
      }
      return true;
    });

    if (!moved) break;
  }

  return result;
}

export interface RelayLoopOptions extends RelayOptions {
  /** Pause between passes that found nothing. */
  idleMs?: number;
  signal?: AbortSignal;
  /** Fired after each pass, for the timer tick to share the same loop. */
  onPass?: () => Promise<void>;
}

/**
 * Poll rather than LISTEN/NOTIFY: a notification is delivered at most once and
 * is lost if no one is listening at that instant, so a LISTEN-only relay
 * silently drops everything written while it was restarting. Polling a single
 * indexed query is cheap, and it recovers on its own.
 */
export async function relayLoop(
  db: Db,
  engine: EventDeliverer,
  options: RelayLoopOptions = {},
): Promise<void> {
  const idleMs = options.idleMs ?? 1000;
  const { signal } = options;

  while (!signal?.aborted) {
    const result = await relayOnce(db, engine, options);
    await options.onPass?.();
    if (result.delivered === 0 && result.failed === 0) {
      await sleep(idleMs, signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // The listener has to be removed when the timer wins, not just when the
    // abort fires: `once` only cleans up on dispatch, so in a loop that mostly
    // times out they accumulate one per pass until Node warns about a leak.
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
