import { nudges, withTenant, type Db } from "@mentorship/db";
import type { NudgeRecordSink } from "./sweep.js";

/**
 * `nudges`, one row per decision the planner reaches — `planned`, `sent` or
 * `dropped` — following `packages/ai/src/postgres.ts` and
 * `packages/primitives/progress/src/postgres.ts`'s exact shape.
 */
export class PostgresNudgeRecordSink implements NudgeRecordSink {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  async record(input: {
    orgId: string;
    pairingId: string;
    recipientParticipantId: string | null;
    channel: string;
    state: "planned" | "sent" | "dropped";
    escalationLevel: number;
    body: string;
    dedupeKey: string;
    droppedReason: string | null;
    sentAt: string | null;
  }): Promise<void> {
    // `nudges.recipient_participant_id` is NOT NULL. An escalation is
    // addressed to whichever human is on call, not to a participant, and
    // there is no queue for that yet — the same honest gap invariant 16
    // flags for `safeguarding`: the flag exists, the destination does not.
    // Nothing is lost by skipping the row: the sweep's own result already
    // surfaces the escalation to its caller.
    if (input.recipientParticipantId === null) return;

    const { role } = this.options;
    const recipientParticipantId = input.recipientParticipantId;
    await withTenant(
      this.db,
      input.orgId,
      async (tx) => {
        await tx.insert(nudges).values({
          orgId: input.orgId,
          pairingId: input.pairingId,
          recipientParticipantId,
          channel: input.channel,
          state: input.state,
          escalationLevel: input.escalationLevel,
          body: input.body,
          dedupeKey: input.dedupeKey,
          droppedReason: input.droppedReason,
          sentAt: input.sentAt === null ? null : new Date(input.sentAt),
        });
      },
      role === undefined ? {} : { role },
    );
  }
}
