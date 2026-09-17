import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  StoredProgramPolicySchema,
  resolveCadence,
  type AdapterCapabilities,
  type Agreement,
  type AgreementResponse,
  type CalendarAdapter,
  type Interval,
  type PairContext,
  type PairParticipant,
  type PairingOrigin,
  type PairingState,
  type SagaResolvers,
  type SlotName,
} from "@mentorship/core";
import {
  agreements,
  cohorts,
  consents,
  identityLinks,
  integrationBindings,
  pairings,
  participants,
  programs,
  users,
  withTenant,
  type Db,
} from "@mentorship/db";
import {
  documentUrl,
  GoogleDriveDocumentConfigSchema,
  type IntegrationRegistry,
} from "@mentorship/integrations";

/**
 * `SagaResolvers` over the real tables — the Postgres counterpart to
 * `testkit`'s `World`, and the last thing between an event the relay picked up
 * and a saga that actually moves.
 *
 * Reads only. Sagas mutate through effects, so nothing here writes, which is
 * also why none of it needs an idempotency key.
 */

export interface PostgresResolverOptions {
  db: Db;
  orgId: string;
  /** Live calls — free/busy is never cached, unlike capabilities. */
  registry: IntegrationRegistry;
  /** Passed to `withTenant`; see the note there about superuser connections. */
  role?: string;
}

export class PostgresSagaResolvers implements SagaResolvers {
  constructor(private readonly options: PostgresResolverOptions) {}

  private read<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const { db, orgId, role } = this.options;
    return withTenant(db, orgId, fn, role === undefined ? {} : { role });
  }

  async pairContext(pairingId: string): Promise<PairContext> {
    const { orgId } = this.options;

    return this.read(async (tx) => {
      const [pairing] = await tx
        .select()
        .from(pairings)
        .where(and(eq(pairings.orgId, orgId), eq(pairings.id, pairingId)))
        .limit(1);
      if (!pairing) throw new Error(`unknown pairing ${pairingId}`);

      // Policy is data, so it is read and validated rather than assumed: a
      // tenant whose policy fails the schema should fail loudly here and not
      // three states into a session.
      const [row] = await tx
        .select({ policy: programs.policy, cadenceOverride: cohorts.cadenceOverride })
        .from(cohorts)
        .innerJoin(
          programs,
          and(eq(programs.orgId, cohorts.orgId), eq(programs.id, cohorts.programId)),
        )
        .where(and(eq(cohorts.orgId, orgId), eq(cohorts.id, pairing.cohortId)))
        .limit(1);
      if (!row) throw new Error(`pairing ${pairingId} has no cohort or program`);
      let policy;
      try {
        policy = StoredProgramPolicySchema.parse(row.policy);
      } catch (err) {
        const detail = err instanceof z.ZodError ? err.message : String(err);
        throw new Error(
          `pairing ${pairingId}: stored policy is malformed and cannot be trusted with defaults — ${detail}`,
        );
      }

      const ids = [pairing.mentorParticipantId, pairing.menteeParticipantId];
      const people = await tx
        .select({
          participantId: participants.id,
          role: participants.role,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          tzOffsetMinutes: users.tzOffsetMinutes,
        })
        .from(participants)
        .innerJoin(
          users,
          and(eq(users.orgId, participants.orgId), eq(users.id, participants.userId)),
        )
        .where(and(eq(participants.orgId, orgId), inArray(participants.id, ids)));

      const links = await tx
        .select({
          userId: identityLinks.userId,
          provider: identityLinks.provider,
          externalId: identityLinks.externalId,
          verifiedAt: identityLinks.verifiedAt,
        })
        .from(identityLinks)
        .where(
          and(
            eq(identityLinks.orgId, orgId),
            inArray(
              identityLinks.userId,
              people.map((p) => p.userId),
            ),
          ),
        );

      const grants = await tx
        .select({
          participantId: consents.participantId,
          kind: consents.kind,
          granted: consents.granted,
          revokedAt: consents.revokedAt,
        })
        .from(consents)
        .where(and(eq(consents.orgId, orgId), inArray(consents.participantId, ids)));

      // The guideline doc the running doc is seeded from, reused as the link
      // participant-facing messages point at. Unconfigured is the normal case,
      // not an error: the messages simply omit the line.
      const [documentBinding] = await tx
        .select({ config: integrationBindings.config })
        .from(integrationBindings)
        .where(
          and(
            eq(integrationBindings.orgId, orgId),
            eq(integrationBindings.slot, "document"),
          ),
        )
        .limit(1);
      const documentConfig = GoogleDriveDocumentConfigSchema.partial().safeParse(
        documentBinding?.config ?? {},
      );
      const playbookUrl =
        documentConfig.success && documentConfig.data.guidelineDocId
          ? documentUrl(documentConfig.data.guidelineDocId)
          : null;

      const byId = new Map(people.map((p) => [p.participantId, p]));
      const ordered = ids.map((id) => {
        const person = byId.get(id);
        if (!person) throw new Error(`unknown participant ${id}`);
        return person;
      });

      const participantList: PairParticipant[] = ordered.map((person) => {
        // A verified chat link or nothing. An unverified one is a guess, and a
        // guess here puts the wrong person in a private pair thread.
        const chat = links.find(
          (l) =>
            l.userId === person.userId &&
            l.provider === "slack" &&
            l.verifiedAt !== null,
        );
        const calendar = links.find(
          (l) => l.userId === person.userId && l.provider === "google",
        );
        return {
          participantId: person.participantId,
          role: person.role,
          displayName: person.displayName,
          email: person.email,
          memberRef: chat?.externalId ?? `email:${person.email}`,
          calendarRef: calendar?.externalId ?? person.email,
          tzOffsetMinutes: person.tzOffsetMinutes,
          consent: {
            aiProcessing: granted(grants, person.participantId, "ai_processing"),
            recording: granted(grants, person.participantId, "recording"),
          },
        };
      });

      const title = `Mentoring — ${participantList.map((p) => p.displayName).join(" & ")}`;

      return {
        pairingId,
        orgId,
        title,
        state: pairing.state as PairingState,
        origin: pairing.origin as PairingOrigin,
        policy,
        cadence: resolveCadence(
          policy.cadence,
          row.cadenceOverride as Partial<PairContext["cadence"]> | null,
          pairing.cadenceOverride as Partial<PairContext["cadence"]> | null,
        ),
        participants: participantList,
        lastSessionAt: pairing.lastSessionAt?.toISOString() ?? null,
        documentRef: pairing.documentRef,
        playbookUrl,
      };
    });
  }

  async freeBusy(input: {
    calendarRefs: string[];
    window: Interval;
  }): Promise<Record<string, Interval[]>> {
    const calendar = this.options.registry.get<CalendarAdapter>("calendar");
    if (!calendar) return {};
    return calendar.freeBusy({
      memberRefs: input.calendarRefs,
      window: input.window,
    });
  }

  async agreement(agreementId: string): Promise<Agreement | null> {
    const { orgId } = this.options;
    return this.read(async (tx) => {
      const [row] = await tx
        .select()
        .from(agreements)
        .where(and(eq(agreements.orgId, orgId), eq(agreements.id, agreementId)))
        .limit(1);
      if (!row) return null;
      return {
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
    });
  }

  async capabilities(slot: SlotName): Promise<AdapterCapabilities | null> {
    const { orgId } = this.options;
    // The *probed* capabilities cached on the binding, not what the adapter
    // class claims (ADR-0006): whether a tenant can actually get a transcript
    // depends on their edition and their admin's settings, which is knowable
    // only by asking, and is asked once at connect time.
    return this.read(async (tx) => {
      const [row] = await tx
        .select({ capabilities: integrationBindings.capabilities })
        .from(integrationBindings)
        .where(
          and(
            eq(integrationBindings.orgId, orgId),
            eq(integrationBindings.slot, slot),
          ),
        )
        .limit(1);
      if (!row?.capabilities) return null;
      return row.capabilities as AdapterCapabilities;
    });
  }
}

function granted(
  rows: {
    participantId: string;
    kind: string;
    granted: boolean;
    revokedAt: Date | null;
  }[],
  participantId: string,
  kind: string,
): boolean {
  const row = rows.find(
    (r) => r.participantId === participantId && r.kind === kind,
  );
  // Absent means not granted, and a revocation outranks the grant that came
  // before it. Both default to no, which is the only safe direction.
  return row ? row.granted && row.revokedAt === null : false;
}
