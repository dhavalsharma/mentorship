import { and, eq } from "drizzle-orm";
import {
  subjectRef,
  type Cadence,
  type PairingOrigin,
  type PairingState,
  type ProgramPolicy,
} from "@mentorship/core";
import {
  cohorts,
  consents,
  identityLinks,
  integrationBindings,
  organizations,
  pairings,
  participants,
  programs,
  users,
  type Db,
} from "@mentorship/db";
import type { IntegrationRegistry } from "@mentorship/integrations";
import type { PlannedPerson, RosterSink } from "@mentorship/roster";
import { PostgresEventSink } from "@mentorship/workflows/postgres";

/**
 * Everything a journey is allowed to write directly — and only before the
 * journey starts. After seeding, the only doors are HTTP and the clock.
 *
 * Three things here stand in for doors that do not exist yet, and each is a
 * real gap rather than a test convenience:
 *
 *   - **No shipped Postgres `RosterSink`.** `commitRosterImport` is real and
 *     is what runs here, but the only sink the repo ships is testkit's
 *     in-memory `World`; importing a roster on Postgres has no product path.
 *     `PostgresRosterSink` below is the one hand-written part of the seed, and
 *     it writes exactly the rows `PostgresSagaResolvers` reads back.
 *   - **No connect flow persists probed capabilities.** ADR-0006 says
 *     capabilities are probed once at connect time and cached on the binding
 *     — and `PostgresSagaResolvers.capabilities()` reads *only* that cache —
 *     but nothing in the repo writes `integration_bindings.capabilities`.
 *     Without `bindProbedCapabilities` a Postgres tenant reads every slot as
 *     `null`: proposals always degrade, no buttons are ever assumed, and a
 *     transcript is never polled for. See the report in
 *     `docs/e2e-testing-strategy.md`.
 *   - **Identity verification.** Roster chat refs are recorded as verified
 *     links, standing in for `acceptInvite` (`packages/enrollment`), which has
 *     no HTTP route to drive.
 */

export interface SeedOrgInput {
  orgId: string;
  policy: ProgramPolicy;
  /** Stamped on seed rows; the org's own clock, not the wall clock. */
  at: Date;
}

export interface SeededOrg {
  orgId: string;
  programId: string;
  cohortId: string;
}

export async function seedOrg(db: Db, input: SeedOrgInput): Promise<SeededOrg> {
  const { orgId } = input;
  await db
    .insert(organizations)
    .values({ id: orgId, name: `E2E ${orgId.slice(0, 8)}`, slug: `e2e-${orgId}` });
  const [program] = await db
    .insert(programs)
    .values({ orgId, name: "Career Mentoring", policy: input.policy })
    .returning({ id: programs.id });
  const [cohort] = await db
    .insert(cohorts)
    .values({
      orgId,
      programId: program!.id,
      name: "Journey cohort",
      startsAt: new Date(input.at.getTime() - 30 * 86_400_000),
      endsAt: new Date(input.at.getTime() + 180 * 86_400_000),
    })
    .returning({ id: cohorts.id });
  return { orgId, programId: program!.id, cohortId: cohort!.id };
}

/**
 * What a connect flow would do: probe each bound adapter and cache the answer
 * on its binding row — the only place the Postgres resolvers look.
 */
export async function bindProbedCapabilities(
  db: Db,
  orgId: string,
  registry: IntegrationRegistry,
  at: Date,
): Promise<void> {
  for (const slot of registry.boundSlots()) {
    const adapter = registry.require(slot);
    const capabilities = await adapter.probe();
    await db.insert(integrationBindings).values({
      orgId,
      slot,
      adapterId: adapter.id,
      capabilities,
      probedAt: at,
    });
  }
}

export interface ConsentSeed {
  aiProcessing?: boolean;
  recording?: boolean;
}

/**
 * `RosterSink` over the tables `PostgresSagaResolvers.pairContext()` reads.
 * `announce` goes through the real `PostgresEventSink`, so `pair.activated`
 * enters the outbox exactly as any other producer's event would.
 */
export class PostgresRosterSink implements RosterSink {
  private readonly sink: PostgresEventSink;

  constructor(
    private readonly db: Db,
    private readonly org: SeededOrg,
    private readonly options: { now: () => Date; consents?: ConsentSeed },
  ) {
    this.sink = new PostgresEventSink(db, { now: options.now });
  }

  async upsertPerson(person: PlannedPerson): Promise<{ participantId: string }> {
    const { orgId, cohortId } = this.org;
    const at = this.options.now();
    await this.db
      .insert(users)
      .values({
        orgId,
        email: person.email,
        displayName: person.displayName,
        tzOffsetMinutes: person.tzOffsetMinutes,
      })
      .onConflictDoNothing();
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, person.email)));

    if (person.chatRef) {
      await this.db
        .insert(identityLinks)
        .values({
          orgId,
          userId: user!.id,
          provider: "slack",
          externalId: person.chatRef,
          verifiedAt: at,
        })
        .onConflictDoNothing();
    }

    await this.db
      .insert(participants)
      .values({ orgId, cohortId, userId: user!.id, role: person.role })
      .onConflictDoNothing();
    const [participant] = await this.db
      .select({ id: participants.id })
      .from(participants)
      .where(
        and(
          eq(participants.orgId, orgId),
          eq(participants.cohortId, cohortId),
          eq(participants.userId, user!.id),
          eq(participants.role, person.role),
        ),
      );

    const grants = this.options.consents ?? {};
    for (const [kind, granted] of [
      ["ai_processing", grants.aiProcessing],
      ["recording", grants.recording],
    ] as const) {
      if (granted === undefined) continue;
      await this.db.insert(consents).values({
        orgId,
        participantId: participant!.id,
        kind,
        granted,
        grantedAt: granted ? at : null,
      });
    }

    await this.sink.emit({
      orgId,
      name: "participant.enrolled",
      subjectRef: subjectRef("participant", participant!.id),
      payload: { email: person.email, role: person.role },
    });
    return { participantId: participant!.id };
  }

  async createPairing(input: {
    pairKey: string;
    mentorParticipantId: string;
    menteeParticipantId: string;
    state: PairingState;
    origin: PairingOrigin;
    cadenceOverride: Partial<Cadence> | null;
    startsAt: string | null;
    notes: string | null;
    importFileHash: string;
  }): Promise<{ pairingId: string }> {
    const [row] = await this.db
      .insert(pairings)
      .values({
        orgId: this.org.orgId,
        cohortId: this.org.cohortId,
        mentorParticipantId: input.mentorParticipantId,
        menteeParticipantId: input.menteeParticipantId,
        pairKey: input.pairKey,
        state: input.state,
        origin: input.origin,
        cadenceOverride: input.cadenceOverride,
        notes: input.notes,
        importFileHash: input.importFileHash,
      })
      .returning({ id: pairings.id });
    return { pairingId: row!.id };
  }

  async announce(input: {
    pairingId: string;
    state: PairingState;
    participantIds: string[];
  }): Promise<void> {
    await this.sink.emit({
      orgId: this.org.orgId,
      name: input.state === "active" ? "pair.activated" : "pair.offered",
      subjectRef: subjectRef("pairing", input.pairingId),
      payload: { participantIds: input.participantIds },
    });
  }
}
