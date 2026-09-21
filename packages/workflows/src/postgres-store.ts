import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { DomainEvent, EventPattern, SagaInstance } from "@mentorship/core";
import { matchesPattern } from "@mentorship/core";
import { sagaInstances, type Db } from "@mentorship/db";
import { SagaConflictError, type SagaStore } from "./store.js";

/**
 * The Postgres `SagaStore` — a thin translation of `MemorySagaStore`'s six
 * methods over the `saga_instances` table. This is imported from
 * `@mentorship/workflows/postgres` rather than the package root on purpose:
 * pulling it into the root entry would make every test and `pnpm demo` load
 * the pg driver to run a suite that deliberately touches no database.
 *
 * Isolation is the caller's decision, as everywhere else that touches `db`.
 * Pass a `Db` already inside `withTenant` for per-request work; the timer tick
 * and the relay legitimately cross tenants and pass an admin-scoped one.
 */
export class PostgresSagaStore implements SagaStore {
  constructor(private readonly db: Db) {}

  async create(instance: SagaInstance): Promise<SagaInstance> {
    assertUuid(instance.id, "saga instance id");
    assertUuid(instance.orgId, "orgId");
    try {
      const [row] = await this.db
        .insert(sagaInstances)
        .values(toRow(instance))
        .returning();
      if (!row) throw new Error(`saga instance ${instance.id} was not inserted`);
      return toInstance(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`saga instance ${instance.id} already exists`);
      }
      throw error;
    }
  }

  async get(id: string): Promise<SagaInstance | null> {
    const [row] = await this.db
      .select()
      .from(sagaInstances)
      .where(eq(sagaInstances.id, id))
      .limit(1);
    return row ? toInstance(row) : null;
  }

  async save(
    instance: SagaInstance,
    expectedVersion: number,
  ): Promise<SagaInstance> {
    // The whole point of the store: a stale write is rejected, never merged.
    // `WHERE version = $expected` makes the check and the write one statement,
    // so two workers racing the same step cannot both win.
    const [row] = await this.db
      .update(sagaInstances)
      .set(toRow(instance))
      .where(
        and(
          eq(sagaInstances.id, instance.id),
          eq(sagaInstances.version, expectedVersion),
        ),
      )
      .returning();

    if (row) return toInstance(row);

    const current = await this.get(instance.id);
    if (!current) throw new Error(`saga instance ${instance.id} not found`);
    throw new SagaConflictError(instance.id, expectedVersion, current.version);
  }

  async findAwaiting(event: DomainEvent): Promise<SagaInstance[]> {
    // Narrowed in SQL so the work stays on the index, then re-checked in JS
    // with the same `matchesPattern` the memory store uses — the two stores
    // must not be able to disagree about which sagas an event wakes.
    const rows = await this.db
      .select()
      .from(sagaInstances)
      .where(
        and(
          eq(sagaInstances.status, "running"),
          eq(sagaInstances.orgId, event.orgId),
          sql`jsonb_exists(${sagaInstances.awaitingEvent} -> 'names', ${event.name})`,
        ),
      );
    return rows
      .map(toInstance)
      .filter((i) => matchesPattern(event, i.awaitingEvent));
  }

  async findDue(now: Date, orgId?: string): Promise<SagaInstance[]> {
    const rows = await this.db
      .select()
      .from(sagaInstances)
      .where(
        and(
          eq(sagaInstances.status, "running"),
          isNotNull(sagaInstances.timeoutAt),
          lte(sagaInstances.timeoutAt, now),
          ...(orgId ? [eq(sagaInstances.orgId, orgId)] : []),
        ),
      );
    return rows.map(toInstance);
  }

  async findBySubject(
    sagaName: string,
    subjectRef: string,
  ): Promise<SagaInstance | null> {
    const [row] = await this.db
      .select()
      .from(sagaInstances)
      .where(
        and(
          eq(sagaInstances.sagaName, sagaName),
          eq(sagaInstances.subjectRef, subjectRef),
        ),
      )
      .orderBy(desc(sagaInstances.createdAt))
      .limit(1);
    return row ? toInstance(row) : null;
  }

  async list(): Promise<SagaInstance[]> {
    const rows = await this.db.select().from(sagaInstances);
    return rows.map(toInstance);
  }
}

type Row = typeof sagaInstances.$inferSelect;

function toRow(instance: SagaInstance): typeof sagaInstances.$inferInsert {
  return {
    id: instance.id,
    orgId: instance.orgId,
    sagaName: instance.sagaName,
    subjectRef: instance.subjectRef,
    state: instance.state,
    awaitingEvent: instance.awaitingEvent,
    timeoutAt: instance.timeoutAt === null ? null : new Date(instance.timeoutAt),
    version: instance.version,
    stepIndex: instance.stepIndex,
    completedEffects: instance.completedEffects,
    history: instance.history,
    status: instance.status,
    createdAt: new Date(instance.createdAt),
    updatedAt: new Date(instance.updatedAt),
  };
}

function toInstance(row: Row): SagaInstance {
  return {
    id: row.id,
    orgId: row.orgId,
    sagaName: row.sagaName,
    subjectRef: row.subjectRef,
    state: row.state,
    awaitingEvent: (row.awaitingEvent as EventPattern | null) ?? null,
    timeoutAt: row.timeoutAt === null ? null : row.timeoutAt.toISOString(),
    version: row.version,
    stepIndex: row.stepIndex,
    completedEffects: row.completedEffects as Record<string, unknown>,
    history: row.history as SagaInstance["history"],
    status: row.status as SagaInstance["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `uuidIds` produces `sga_<uuid>` and `sequentialIds` produces `sga_001`;
 * neither fits a `uuid` column. Failing here with the fix named beats letting
 * Postgres raise `invalid input syntax for type uuid` three frames away.
 */
function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) {
    throw new Error(
      `${what} must be a bare uuid for PostgresSagaStore, got "${value}" — ` +
        `construct the engine with \`bareUuidIds\` from @mentorship/core`,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
