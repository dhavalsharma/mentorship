import type { DomainEvent, SagaInstance } from "@mentorship/core";
import { matchesPattern } from "@mentorship/core";

export class SagaConflictError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`saga ${id} version conflict: expected ${expected}, found ${actual}`);
    this.name = "SagaConflictError";
  }
}

/**
 * The store port. The memory implementation below is what the tests and the
 * demo run on; the Postgres implementation is a thin translation of the same
 * six methods over the `saga_instances` table (see packages/db/schema.ts),
 * where `save` becomes `UPDATE ... WHERE version = $expected`.
 */
export interface SagaStore {
  create(instance: SagaInstance): Promise<SagaInstance>;
  get(id: string): Promise<SagaInstance | null>;
  /** Optimistic concurrency: a stale write is rejected, never merged. */
  save(instance: SagaInstance, expectedVersion: number): Promise<SagaInstance>;
  findAwaiting(event: DomainEvent): Promise<SagaInstance[]>;
  /** Unscoped when `orgId` is omitted — callers that cross tenants must opt in. */
  findDue(now: Date, orgId?: string): Promise<SagaInstance[]>;
  findBySubject(sagaName: string, subjectRef: string): Promise<SagaInstance | null>;
  list(): Promise<SagaInstance[]>;
}

export class MemorySagaStore implements SagaStore {
  private readonly rows = new Map<string, SagaInstance>();

  async create(instance: SagaInstance): Promise<SagaInstance> {
    if (this.rows.has(instance.id)) {
      throw new Error(`saga instance ${instance.id} already exists`);
    }
    this.rows.set(instance.id, structuredClone(instance));
    return structuredClone(instance);
  }

  async get(id: string): Promise<SagaInstance | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async save(
    instance: SagaInstance,
    expectedVersion: number,
  ): Promise<SagaInstance> {
    const current = this.rows.get(instance.id);
    if (!current) throw new Error(`saga instance ${instance.id} not found`);
    if (current.version !== expectedVersion) {
      throw new SagaConflictError(instance.id, expectedVersion, current.version);
    }
    this.rows.set(instance.id, structuredClone(instance));
    return structuredClone(instance);
  }

  async findAwaiting(event: DomainEvent): Promise<SagaInstance[]> {
    return [...this.rows.values()]
      .filter(
        (i) =>
          i.status === "running" &&
          i.orgId === event.orgId &&
          awaits(i, event),
      )
      .map((i) => structuredClone(i));
  }

  async findDue(now: Date, orgId?: string): Promise<SagaInstance[]> {
    const at = now.getTime();
    return [...this.rows.values()]
      .filter(
        (i) =>
          i.status === "running" &&
          i.timeoutAt !== null &&
          Date.parse(i.timeoutAt) <= at &&
          (orgId === undefined || i.orgId === orgId),
      )
      .map((i) => structuredClone(i));
  }

  async findBySubject(
    sagaName: string,
    subjectRef: string,
  ): Promise<SagaInstance | null> {
    const found = [...this.rows.values()].find(
      (i) => i.sagaName === sagaName && i.subjectRef === subjectRef,
    );
    return found ? structuredClone(found) : null;
  }

  async list(): Promise<SagaInstance[]> {
    return [...this.rows.values()].map((i) => structuredClone(i));
  }
}

/**
 * Whether `event` wakes `instance`: what it waits for now, or what the step
 * it has in flight will wait for. The second half matters because a step can
 * emit the very event its next state waits on and then fail on a later
 * effect — `create_calendar_event` emits `session.scheduled`, then the
 * booked confirmation fails to send. The relay delivers that event while the
 * instance still waits for the step's *input* pattern; matching only
 * `awaitingEvent` dropped it as unwanted, the step was later finished by its
 * own retry, and the saga sat in `scheduling` for an event that had already
 * gone by until it paused `calendar_never_confirmed` on a booked session.
 * Matched on the pending step too, the event finishes that step (the engine
 * always does, before anything else) and is then offered to the state it
 * landed in — which is waiting for it. Shared with `PostgresSagaStore` so the
 * two stores cannot disagree about which sagas an event wakes.
 */
export function awaits(instance: SagaInstance, event: DomainEvent): boolean {
  return (
    matchesPattern(event, instance.awaitingEvent) ||
    matchesPattern(event, instance.pendingStep?.waitFor ?? null)
  );
}
