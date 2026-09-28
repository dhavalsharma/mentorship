import { and, desc, eq, isNotNull, lt, or } from "drizzle-orm";
import { events, sagaInstances, withTenant, type Db } from "@mentorship/db";

/**
 * Read-only queries for the admin monitoring gap ROADMAP phase 1 names:
 * "saga instances not advanced in N days; dead-letter review." Kept here
 * rather than in `apps/api/src/postgres-reads.ts` because both tables this
 * reads (`saga_instances`, `events`) are this package's own domain — the
 * engine and the relay already own the write side of both.
 *
 * Same shape as `PostgresRiskFindingsSink`/`apps/api/src/postgres-reads.ts`:
 * scoped by `org_id`, run inside `withTenant`, and the caller decides
 * whether to pass a restricted `role` (RLS still applies either way).
 */

const DEFAULT_STUCK_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StuckSagaQueryOptions {
  /** Days since last progress (`updated_at`) before a running instance counts as stuck. Default 3. */
  olderThanDays?: number;
  limit: number;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => Date;
  role?: string;
}

/**
 * `running` saga instances whose `updatedAt` is older than `olderThanDays`,
 * plus every `failed` instance regardless of age. `failed` is what the engine
 * writes when it *parks* an instance whose timer step kept throwing
 * (`SagaEngine.tick`, after `maxStepAttempts`) — the durable "a human needs to
 * look at this" marker, so hiding it behind an age threshold would hide it for
 * three days. `done` is never stuck. Oldest-first, since the longest-stuck
 * instance is the most urgent one.
 */
export async function listStuckSagaInstances(
  db: Db,
  orgId: string,
  options: StuckSagaQueryOptions,
): Promise<unknown[]> {
  const olderThanDays = options.olderThanDays ?? DEFAULT_STUCK_DAYS;
  const now = (options.now ?? (() => new Date()))();
  const threshold = new Date(now.getTime() - olderThanDays * MS_PER_DAY);

  return withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select()
        .from(sagaInstances)
        .where(
          and(
            eq(sagaInstances.orgId, orgId),
            or(
              and(
                eq(sagaInstances.status, "running"),
                lt(sagaInstances.updatedAt, threshold),
              ),
              eq(sagaInstances.status, "failed"),
            ),
          ),
        )
        .orderBy(sagaInstances.updatedAt)
        .limit(options.limit),
    options.role === undefined ? {} : { role: options.role },
  );
}

export interface DeadLetterQueryOptions {
  limit: number;
  role?: string;
}

/**
 * Events the relay parked after `maxAttempts` (`relay.ts`'s `onDeadLettered`
 * path) — most recently parked first, since that is the one most likely to
 * still be actionable. `deadLetteredAt` is the parking marker; `lastError`
 * carries why.
 */
export async function listDeadLetteredEvents(
  db: Db,
  orgId: string,
  options: DeadLetterQueryOptions,
): Promise<unknown[]> {
  return withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select()
        .from(events)
        .where(and(eq(events.orgId, orgId), isNotNull(events.deadLetteredAt)))
        .orderBy(desc(events.deadLetteredAt))
        .limit(options.limit),
    options.role === undefined ? {} : { role: options.role },
  );
}
