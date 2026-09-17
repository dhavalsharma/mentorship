import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
  pairings,
  participants,
  withTenant,
  type Db,
} from "@mentorship/db";
import type {
  AgreementResponder,
  ChatIdentityResolver,
  ExtractionResponder,
  NotesSink,
  PairingLocator,
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
              // Explicit, not left to RLS: on a superuser connection RLS is
              // bypassed, and an identity lookup that spans tenants resolves a
              // Slack id in one org to a participant in another.
              eq(identityLinks.orgId, orgId),
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
          .where(
            and(
              eq(agreements.orgId, orgId),
              eq(agreements.id, input.agreementId),
            ),
          )
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
          .where(
            and(
              eq(agreements.orgId, orgId),
              eq(agreements.id, input.agreementId),
            ),
          );

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

/**
 * Channel id -> pair, off the `thread_ref` the `pair.thread_bound` projection
 * writes. This is the whole reason that event exists: a Slack message event
 * carries a channel and a user and nothing else, and guessing the pair from
 * the user alone is wrong the moment a mentor has two mentees.
 */
export class PostgresPairingLocator implements PairingLocator {
  constructor(private readonly options: PostgresPortOptions) {}

  async resolveByChannel(
    channelId: string,
  ): Promise<{ pairingId: string; participantIds: string[] } | null> {
    const { db, orgId, role } = this.options;
    return withTenant(
      db,
      orgId,
      async (tx) => {
        const [row] = await tx
          .select({
            id: pairings.id,
            mentorParticipantId: pairings.mentorParticipantId,
            menteeParticipantId: pairings.menteeParticipantId,
          })
          .from(pairings)
          .where(
            and(
              eq(pairings.orgId, orgId),
              sql`${pairings.threadRef}->>'channelId' = ${channelId}`,
            ),
          )
          .limit(1);
        if (!row) return null;
        return {
          pairingId: row.id,
          participantIds: [row.mentorParticipantId, row.menteeParticipantId],
        };
      },
      role === undefined ? {} : { role },
    );
  }
}

/**
 * Raw text in, one `notes.submitted` row out. Nothing is inferred from the
 * body and nothing is derived from it — see the note at the top of
 * `integrations/slack/events.ts`.
 */
export class PostgresNotesSink implements NotesSink {
  constructor(private readonly options: PostgresPortOptions) {}

  async submit(input: {
    pairingId: string;
    participantId: string;
    noteId: string;
    body: string;
  }): Promise<void> {
    const { db, orgId, role } = this.options;
    const at = this.options.now?.() ?? new Date();
    const subject = subjectRef("pairing", input.pairingId);

    await withTenant(
      db,
      orgId,
      async (tx) => {
        // Slack retries an event it did not hear a 200 for within three
        // seconds, and the retry carries the same `ts`. Without a dedupe a
        // slow response turns one note into two, and the second one is
        // extracted as if the participant said it all again.
        //
        // The dedupe is the database's, not this function's: a
        // SELECT-then-INSERT here runs under READ COMMITTED, so the retry and
        // the original can both find nothing and both insert. The partial
        // unique index `events_note_submitted_unique` (migration 0011) makes
        // the second one a no-op instead — the same shape as every other
        // redelivery guard in this schema (`nudges_dedupe_unique` and
        // friends).
        //
        // No conflict target: the index is partial and keyed on a payload
        // expression, which Drizzle's `target` cannot name, and `events` has
        // no other unique constraint an insert of this shape can hit (`id` is
        // server-generated). Same bare form the projector already uses.
        await tx
          .insert(events)
          .values({
            orgId,
            name: "notes.submitted",
            subjectRef: subject,
            occurredAt: at,
            payload: {
              noteId: input.noteId,
              participantId: input.participantId,
              body: input.body,
            },
          })
          .onConflictDoNothing();
      },
      role === undefined ? {} : { role },
    );
  }
}

/**
 * The Confirm/Edit counterpart to `PostgresAgreementResponder`.
 *
 * The pairing is resolved from the append-only log rather than taken from the
 * button's payload: Slack signs the request, but the value inside it is
 * whatever we put there, and a verdict recorded against a pair on the strength
 * of a client-echoed id is one schema change away from being recorded against
 * the wrong one. The `extractions` table would be the natural home for this
 * lookup, but nothing writes it yet — `extraction.completed` is the fact that
 * exists, so that is what is read.
 */
export class PostgresExtractionResponder implements ExtractionResponder {
  constructor(private readonly options: PostgresPortOptions) {}

  async respond(input: {
    extractionId: string;
    participantId: string;
    kind: "confirm" | "edit";
  }): Promise<void> {
    const { db, orgId, role } = this.options;
    const at = this.options.now?.() ?? new Date();

    await withTenant(
      db,
      orgId,
      async (tx) => {
        const [completed] = await tx
          .select({ subjectRef: events.subjectRef })
          .from(events)
          .where(
            and(
              eq(events.orgId, orgId),
              eq(events.name, "extraction.completed"),
              sql`${events.payload}->>'extractionId' = ${input.extractionId}`,
            ),
          )
          .orderBy(desc(events.occurredAt))
          .limit(1);
        if (!completed) {
          throw new Error(`unknown extraction ${input.extractionId}`);
        }
        const pairingId = completed.subjectRef.split(":")[1] ?? "";

        // A verdict is only a verdict from someone whose session this was.
        const [pairing] = await tx
          .select({
            mentorParticipantId: pairings.mentorParticipantId,
            menteeParticipantId: pairings.menteeParticipantId,
          })
          .from(pairings)
          .where(and(eq(pairings.orgId, orgId), eq(pairings.id, pairingId)))
          .limit(1);
        if (
          !pairing ||
          ![
            pairing.mentorParticipantId,
            pairing.menteeParticipantId,
          ].includes(input.participantId)
        ) {
          throw new Error(
            `${input.participantId} is not a party to extraction ${input.extractionId}`,
          );
        }

        await tx.insert(events).values({
          orgId,
          name:
            input.kind === "edit"
              ? "extraction.edited"
              : "extraction.confirmed",
          // Addressed to the pairing, because that is what the saga's
          // `confirming` state waits on.
          subjectRef: completed.subjectRef,
          occurredAt: at,
          payload: {
            extractionId: input.extractionId,
            participantId: input.participantId,
          },
        });
      },
      role === undefined ? {} : { role },
    );
  }
}

/** Unrelayed events for this org, oldest first — what the relay will drain. */
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
      // The `org_id` predicate is not redundant with RLS. RLS is the net that
      // catches a query which forgot it — and it catches nothing at all on a
      // superuser connection, which is what local and CI runs use. A query
      // whose correctness depends on the connecting role is a query that
      // behaves differently in dev and in production.
      .where(and(eq(events.orgId, orgId), isNull(events.relayedAt)))
      .orderBy(events.occurredAt)
      .limit(limit),
  );
}
