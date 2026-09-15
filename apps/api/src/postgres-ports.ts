import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  recordResponse,
  subjectRef,
  type Agreement,
  type AgreementResponse,
  type ResponseKind,
} from "@mentorship/core";
import {
  agreements,
  events,
  identityLinks,
  participants,
  withTenant,
  type Db,
} from "@mentorship/db";
import type {
  AgreementResponder,
  ChatIdentityResolver,
} from "@mentorship/integrations";

/**
 * The two ports the Slack route needs, backed by Postgres instead of the
 * in-memory world. The route itself does not change — that was the point of
 * expressing them as ports in the first place.
 *
 * Both are constructed per organisation. A multi-workspace Slack app resolves
 * the workspace's `team_id` to an org before it gets here; that mapping is not
 * built yet, so `apps/api` is configured with one.
 */

export interface PostgresPortOptions {
  db: Db;
  orgId: string;
  /**
   * Passed through to `withTenant`. Locally the connection is the superuser,
   * which bypasses RLS, so a deployment that wants the policy enforced names
   * the unprivileged role here.
   */
  role?: string;
  now?: () => Date;
}

export class PostgresChatIdentityResolver implements ChatIdentityResolver {
  constructor(
    private readonly options: PostgresPortOptions,
    private readonly provider = "slack",
  ) {}

  async resolveParticipantId(externalId: string): Promise<string | null> {
    const { db, orgId, role } = this.options;
    return withTenant(
      db,
      orgId,
      async (tx) => {
        // Only a *verified* link counts. Matching a Slack member to a
        // participant any other way eventually puts the wrong person in a
        // private pair thread, which a pilot does not survive.
        const [row] = await tx
          .select({ participantId: participants.id })
          .from(identityLinks)
          .innerJoin(
            participants,
            and(
              eq(participants.orgId, identityLinks.orgId),
              eq(participants.userId, identityLinks.userId),
            ),
          )
          .where(
            and(
              eq(identityLinks.provider, this.provider),
              eq(identityLinks.externalId, externalId),
              isNotNull(identityLinks.verifiedAt),
            ),
          )
          .limit(1);
        return row?.participantId ?? null;
      },
      role === undefined ? {} : { role },
    );
  }
}

export class PostgresAgreementResponder implements AgreementResponder {
  constructor(private readonly options: PostgresPortOptions) {}

  async respond(input: {
    agreementId: string;
    participantId: string;
    kind: ResponseKind;
    optionId?: string;
  }): Promise<void> {
    const { db, orgId, role } = this.options;
    const at = (this.options.now?.() ?? new Date()).toISOString();

    await withTenant(
      db,
      orgId,
      async (tx) => {
        // FOR UPDATE because two people clicking at once is the normal case,
        // not the edge case: without it the second write reads a stale
        // responses array and silently drops the first person's answer.
        const [row] = await tx
          .select()
          .from(agreements)
          .where(eq(agreements.id, input.agreementId))
          .for("update")
          .limit(1);
        if (!row) throw new Error(`unknown agreement ${input.agreementId}`);

        const current: Agreement = {
          id: row.id,
          subject: "session_time",
          pairingId: row.pairingId,
          participantIds: row.participantIds as string[],
          options: row.options as Agreement["options"],
          responses: row.responses as AgreementResponse[],
          round: row.round,
          openedAt: row.createdAt.toISOString(),
          timeoutAt: row.timeoutAt.toISOString(),
        };

        // core's resolver owns the rules: it rejects a stranger and an unknown
        // option. Validation lives there so the endpoint and any future
        // surface cannot drift apart on what counts as a response.
        const next = recordResponse(current, {
          participantId: input.participantId,
          kind: input.kind,
          optionId: input.optionId,
          at,
        });

        await tx
          .update(agreements)
          .set({ responses: next.responses, updatedAt: new Date(at) })
          .where(eq(agreements.id, input.agreementId));

        // Written in the same transaction as the state change: the outbox.
        // The saga advances when the relay picks this up, which is why the
        // endpoint can return 200 well inside Slack's deadline.
        await tx.insert(events).values({
          orgId,
          name: "agreement.responded",
          subjectRef: subjectRef("agreement", input.agreementId),
          occurredAt: new Date(at),
          payload: {
            agreementId: input.agreementId,
            participantId: input.participantId,
            kind: input.kind,
            optionId: input.optionId ?? null,
          },
        });
      },
      role === undefined ? {} : { role },
    );
  }
}

/** Unrelayed events, oldest first — what the relay will drain. */
export async function pendingOutbox(
  db: Db,
  orgId: string,
  limit = 100,
): Promise<{ id: string; name: string; subjectRef: string }[]> {
  return withTenant(db, orgId, async (tx) =>
    tx
      .select({
        id: events.id,
        name: events.name,
        subjectRef: events.subjectRef,
      })
      .from(events)
      .where(sql`${events.relayedAt} is null`)
      .orderBy(events.occurredAt)
      .limit(limit),
  );
}
