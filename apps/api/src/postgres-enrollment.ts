import { and, eq, sql } from "drizzle-orm";
import { ProgramPolicySchema } from "@mentorship/core";
import {
  auditLog,
  cohorts,
  identityLinks,
  participants,
  programs,
  users,
  withTenant,
  type Db,
} from "@mentorship/db";
import {
  acceptPendingInvites,
  commitInvite,
  type AuditSink,
  type EnrollmentSink,
  type InvitePlan,
  type PendingInviteSource,
} from "@mentorship/enrollment";
import type { EnrollmentService, InviteOutcome } from "./server.js";

/**
 * `packages/enrollment`'s ports, backed by Postgres.
 *
 * Both sinks are built on a transaction that is *already* inside
 * `withTenant`, rather than opening one per method the way
 * `PostgresMagicLinkStore` does. An invite is several writes — the user, the
 * participant, the audit row — and an acceptance is three more; one
 * transaction per call would let a crash leave a participant with no audit
 * row, or an `identity.verified` audit row for a participant still
 * `invited`. `PostgresEnrollmentService` below owns the one transaction and
 * hands both sinks the same `tx`.
 */
export class PostgresEnrollmentSink implements EnrollmentSink, PendingInviteSource {
  constructor(
    private readonly tx: Db,
    private readonly orgId: string,
  ) {}

  /**
   * Never overwrites an existing user's name or zone: an invite knows less
   * about a person than a roster import (or the person themselves) already
   * recorded, so a re-invite must not quietly reset someone's zone to UTC.
   */
  async upsertUser(input: {
    email: string;
    displayName: string;
    tzOffsetMinutes: number;
  }): Promise<{ userId: string }> {
    const [inserted] = await this.tx
      .insert(users)
      .values({ orgId: this.orgId, ...input })
      .onConflictDoNothing({ target: [users.orgId, users.email] })
      .returning({ id: users.id });
    if (inserted) return { userId: inserted.id };
    const [existing] = await this.tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, this.orgId), eq(users.email, input.email)))
      .limit(1);
    if (!existing) throw new Error("user upsert found neither a new nor an existing row");
    return { userId: existing.id };
  }

  async findParticipant(input: {
    cohortId: string;
    userId: string;
    role: string;
  }): Promise<{ participantId: string; state: string } | null> {
    const [row] = await this.tx
      .select({ id: participants.id, state: participants.state })
      .from(participants)
      .where(
        and(
          eq(participants.orgId, this.orgId),
          eq(participants.cohortId, input.cohortId),
          eq(participants.userId, input.userId),
          eq(participants.role, input.role),
        ),
      )
      .limit(1);
    return row ? { participantId: row.id, state: row.state } : null;
  }

  async createParticipant(input: {
    cohortId: string;
    userId: string;
    role: string;
    capacity: number | null;
    state: "invited";
  }): Promise<{ participantId: string }> {
    // No ON CONFLICT here on purpose. `commitInvite` has just looked for this
    // row inside the same transaction; a concurrent identical invite that
    // wins the race makes this insert fail on `participants_unique`, and the
    // whole transaction (audit row included) rolls back — a 500 the admin
    // can retry into a clean dedupe, rather than a silent second
    // `participant.invited` audit row for one participant.
    const [row] = await this.tx
      .insert(participants)
      .values({ orgId: this.orgId, ...input })
      .returning({ id: participants.id });
    if (!row) throw new Error("failed to create participant");
    return { participantId: row.id };
  }

  /**
   * Idempotent on `identity_links_unique` (org, provider, external id): a
   * second acceptance keeps the *first* verification time. The `WHERE`
   * guards the one case where the conflict is not "the same fact again" —
   * an external id already linked to a *different* user is left alone
   * rather than silently re-pointed at this one.
   */
  async linkIdentity(input: {
    userId: string;
    provider: string;
    externalId: string;
    verifiedAt: string;
  }): Promise<void> {
    await this.tx
      .insert(identityLinks)
      .values({
        orgId: this.orgId,
        userId: input.userId,
        provider: input.provider,
        externalId: input.externalId,
        verifiedAt: new Date(input.verifiedAt),
      })
      .onConflictDoUpdate({
        target: [identityLinks.orgId, identityLinks.provider, identityLinks.externalId],
        set: {
          verifiedAt: sql`coalesce(${identityLinks.verifiedAt}, excluded.verified_at)`,
          updatedAt: new Date(),
        },
        setWhere: sql`${identityLinks.userId} = excluded.user_id`,
      });
  }

  async updateParticipantState(input: {
    participantId: string;
    state: string;
  }): Promise<void> {
    await this.tx
      .update(participants)
      .set({ state: input.state, updatedAt: new Date() })
      .where(
        and(eq(participants.orgId, this.orgId), eq(participants.id, input.participantId)),
      );
  }

  async listInvitedParticipants(input: {
    userId: string;
  }): Promise<{ participantId: string }[]> {
    const rows = await this.tx
      .select({ id: participants.id })
      .from(participants)
      .where(
        and(
          eq(participants.orgId, this.orgId),
          eq(participants.userId, input.userId),
          eq(participants.state, "invited"),
        ),
      );
    return rows.map((r) => ({ participantId: r.id }));
  }
}

/** The first writer of `audit_log` — see `packages/enrollment/src/audit.ts`. */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly tx: Db) {}

  async record(input: {
    orgId: string;
    actorType: string;
    actorRef: string | null;
    action: string;
    subjectRef: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    await this.tx.insert(auditLog).values({
      orgId: input.orgId,
      actorType: input.actorType,
      actorRef: input.actorRef,
      action: input.action,
      subjectRef: input.subjectRef,
      before: input.before ?? null,
      after: input.after ?? null,
    });
  }
}

/**
 * The `EnrollmentService` behind `POST /orgs/:orgId/invites` and the
 * accept-on-sign-in step of `POST /auth/verify`. Each call is one
 * `withTenant` transaction, so RLS scopes every read — including the cohort
 * lookup below, which is what makes a foreign org's cohort id indistinguish-
 * able from one that does not exist.
 */
export class PostgresEnrollmentService implements EnrollmentService {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string; now?: () => Date } = {},
  ) {}

  private run<T>(orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    const { role } = this.options;
    return withTenant(this.db, orgId, fn, role === undefined ? {} : { role });
  }

  async invite(
    orgId: string,
    plan: InvitePlan,
    actorUserId: string,
  ): Promise<InviteOutcome> {
    return this.run(orgId, async (tx) => {
      // `participants.cohort_id` has no foreign key, so without this check an
      // invite to a mistyped (or another org's) cohort id would create a
      // participant nothing can ever find.
      const [cohort] = await tx
        .select({ policy: programs.policy })
        .from(cohorts)
        .innerJoin(programs, eq(programs.id, cohorts.programId))
        .where(and(eq(cohorts.orgId, orgId), eq(cohorts.id, plan.cohortId)))
        .limit(1);
      if (!cohort) return { ok: false, reason: "unknown_cohort" };

      // The role is program policy (ADR-0001) — checked against the cohort's
      // own program, never a hardcoded "mentor"/"mentee". Only `roles` is
      // parsed: `StoredProgramPolicySchema` would refuse a stored policy that
      // leaves consent implicit, which is right for anything reading consent
      // and irrelevant to "which roles exist". An absent `roles` gets the
      // schema's own default; a malformed one refuses every role.
      const policy = ProgramPolicySchema.pick({ roles: true }).safeParse(
        cohort.policy ?? {},
      );
      const roles = policy.success ? policy.data.roles : [];
      if (!roles.includes(plan.role)) {
        return { ok: false, reason: "unknown_role", roles };
      }

      const result = await commitInvite(
        { ...plan, orgId },
        new PostgresEnrollmentSink(tx, orgId),
        new PostgresAuditSink(tx),
        { actorRef: actorUserId },
      );
      return { ok: true, ...result };
    });
  }

  async acceptPendingInvites(
    orgId: string,
    userId: string,
  ): Promise<{ accepted: string[] }> {
    const now = this.options.now ?? (() => new Date());
    return this.run(orgId, async (tx) => {
      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.id, userId)))
        .limit(1);
      if (!user) return { accepted: [] };
      return acceptPendingInvites(
        { userId, email: user.email, now: () => now().toISOString(), orgId },
        new PostgresEnrollmentSink(tx, orgId),
        new PostgresAuditSink(tx),
      );
    });
  }
}
