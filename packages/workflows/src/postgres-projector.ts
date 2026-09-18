import { eq, and } from "drizzle-orm";
import type { DomainEvent } from "@mentorship/core";
import {
  agreements,
  pairings,
  sessions,
  withTenant,
  type Db,
} from "@mentorship/db";

/**
 * The read models the sagas read back — the Postgres counterpart to
 * `World.project()`, which CLAUDE.md promises becomes "outbox-relay
 * subscribers". Without it the flow half-works in a way that is hard to see:
 * the saga emits `agreement.opened`, nothing writes the row, and the response
 * that arrives two days later finds no agreement to record itself against.
 *
 * Applied by the relay *before* the event reaches the engine and in its own
 * committed transaction, because the engine reads on a different connection
 * and would not see an uncommitted row. That makes redelivery possible, so
 * every projection here is idempotent: the second application of an event
 * must be a no-op, not a duplicate or an overwrite of newer state.
 */
export class PostgresProjector {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  async apply(event: DomainEvent): Promise<void> {
    const { role } = this.options;
    await withTenant(
      this.db,
      event.orgId,
      async (tx) => {
        switch (event.name) {
          case "agreement.opened":
            return this.agreementOpened(tx, event);
          case "session.scheduled":
            return this.sessionScheduled(tx, event);
          case "session.held":
            return this.sessionHeld(tx, event);
          case "document.rendered":
            return this.documentRendered(tx, event);
          case "pair.thread_bound":
            return this.threadBound(tx, event);
          default:
            return;
        }
      },
      role === undefined ? {} : { role },
    );
  }

  private async agreementOpened(tx: Db, event: DomainEvent): Promise<void> {
    const p = event.payload;
    const id = str(p["agreementId"]);
    if (!id) return;
    // The only handler here that must NOT read the subject ref. Every other
    // event this projector takes is pairing-scoped at emission, but the `emit`
    // effect re-subjects anything carrying an `agreementId` to
    // `agreement:<id>` (see `createEffectRunner`), so `idFromRef` here returned
    // the agreement's own id and every row's pairing_id equalled its id.
    // Deliberately no fallback to the subject ref: for this event that value is
    // known-wrong rather than merely stale, and there is no FK to catch it, so
    // a missing payload field means dropping the projection rather than
    // writing a pairing id that points at nothing.
    const pairingId = str(p["pairingId"]);
    if (!pairingId) return;
    await tx
      .insert(agreements)
      .values({
        id,
        orgId: event.orgId,
        pairingId,
        subject: "session_time",
        options: p["options"] ?? [],
        participantIds: p["participantIds"] ?? [],
        responses: [],
        round: Number(p["round"] ?? 1),
        timeoutAt: new Date(str(p["timeoutAt"]) ?? event.occurredAt),
      })
      // A redelivered open must not wipe responses recorded since.
      .onConflictDoNothing();
  }

  private async sessionScheduled(tx: Db, event: DomainEvent): Promise<void> {
    const p = event.payload;
    const id = str(p["sessionId"]);
    if (!id) return;
    await tx
      .insert(sessions)
      .values({
        id,
        orgId: event.orgId,
        pairingId: idFromRef(event.subjectRef),
        startsAt: new Date(str(p["startsAt"]) ?? event.occurredAt),
        endsAt: new Date(str(p["endsAt"]) ?? event.occurredAt),
        state: "scheduled",
        source: "calendar",
        calendarEventId: str(p["calendarEventId"]) ?? null,
        conferenceUrl: str(p["conferenceUrl"]) ?? null,
        transcriptionEnabled: Boolean(p["transcriptionEnabled"]),
      })
      .onConflictDoNothing();
  }

  private async sessionHeld(tx: Db, event: DomainEvent): Promise<void> {
    const pairingId = idFromRef(event.subjectRef);
    // Monotonic on purpose: a redelivered older event must not drag the
    // cadence clock backwards, which would read as a pair falling behind.
    const [row] = await tx
      .select({ lastSessionAt: pairings.lastSessionAt })
      .from(pairings)
      .where(and(eq(pairings.orgId, event.orgId), eq(pairings.id, pairingId)))
      .limit(1);
    if (!row) return;
    const at = new Date(event.occurredAt);
    if (row.lastSessionAt && row.lastSessionAt >= at) return;
    await tx
      .update(pairings)
      .set({ lastSessionAt: at })
      .where(and(eq(pairings.orgId, event.orgId), eq(pairings.id, pairingId)));
  }

  /**
   * Last writer wins, which is right here: a rebound thread means the old
   * channel is no longer where this pair talks, and a message arriving from it
   * should stop being attributed to them.
   */
  private async threadBound(tx: Db, event: DomainEvent): Promise<void> {
    const p = event.payload;
    const channelId = str(p["channelId"]);
    if (!channelId) return;
    await tx
      .update(pairings)
      .set({
        threadRef: {
          adapterId: str(p["adapterId"]) ?? "",
          channelId,
          threadId: str(p["threadId"]),
          url: str(p["url"]),
        },
      })
      .where(
        and(
          eq(pairings.orgId, event.orgId),
          eq(pairings.id, idFromRef(event.subjectRef)),
        ),
      );
  }

  private async documentRendered(tx: Db, event: DomainEvent): Promise<void> {
    const docRef = str(event.payload["docRef"]);
    if (!docRef) return;
    const pairingId = idFromRef(event.subjectRef);
    await tx
      .update(pairings)
      .set({ documentRef: docRef })
      .where(and(eq(pairings.orgId, event.orgId), eq(pairings.id, pairingId)));
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function idFromRef(ref: string): string {
  const [, id] = ref.split(":");
  return id ?? "";
}
