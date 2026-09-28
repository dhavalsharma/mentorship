import { z } from "zod";
import type { AuditSink } from "./audit.js";

/**
 * One admin, one email, one cohort, one role — the other end of
 * `@mentorship/roster`'s bulk CSV import. Same shape, though: plan is pure
 * validation, commit does I/O through a narrow sink
 * (`packages/roster/src/import.ts` / `commit.ts` is the template this
 * mirrors). `EnrollmentSink` is declared locally rather than importing a
 * roster type, for the same one-way-dependency reason
 * `packages/primitives/matching/src/round.ts` declares `MatchingCommitSink`
 * locally instead of importing `RosterSink`.
 *
 * A CSV row lands a participant `active`/`offered` because a pairing already
 * exists. A single invite has no pairing yet — the person has not proven they
 * are who the org thinks they are, so they start `"invited"` and only move to
 * `"enrolled"` once `acceptInvite` records a verified identity link. That is
 * the "identity mapping with a verification flow at enrolment" item from the
 * roadmap: participant <-> chat/calendar identity, verified before anything
 * downstream (a private pair thread, a calendar invite) trusts it.
 */

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface EnrollmentSink {
  upsertUser(input: {
    email: string;
    displayName: string;
    tzOffsetMinutes: number;
  }): Promise<{ userId: string }>;
  createParticipant(input: {
    cohortId: string;
    userId: string;
    role: string;
    capacity: number | null;
    state: "invited";
  }): Promise<{ participantId: string }>;
  /** For dedupe — inviting the same person to the same cohort+role twice must not create a second row. */
  findParticipant(input: {
    cohortId: string;
    userId: string;
    role: string;
  }): Promise<{ participantId: string; state: string } | null>;
  linkIdentity(input: {
    userId: string;
    provider: string;
    externalId: string;
    verifiedAt: string;
  }): Promise<void>;
  updateParticipantState(input: {
    participantId: string;
    state: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const EMAIL = z
  .string()
  .trim()
  .min(3)
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "not an email address")
  .transform((v) => v.toLowerCase());

export const InviteInputSchema = z.object({
  email: EMAIL,
  displayName: z.string().trim().min(1),
  tzOffsetMinutes: z.number().int(),
  cohortId: z.string().trim().min(1),
  role: z.string().trim().min(1),
  capacity: z.number().int().nonnegative().optional(),
  /** Tenancy: threaded through so a commit can write an audit row with it. Invariant 3 — every tenant table carries org_id. */
  orgId: z.string().trim().min(1).optional(),
});
export type InviteInput = z.infer<typeof InviteInputSchema>;

export interface InvitePlan {
  email: string;
  displayName: string;
  tzOffsetMinutes: number;
  cohortId: string;
  role: string;
  capacity: number | null;
  orgId: string | null;
}

export interface InviteValidationError {
  ok: false;
  issues: { field: string; message: string }[];
}

export interface InvitePlanResult {
  ok: true;
  plan: InvitePlan;
}

export type PlanInviteResult = InvitePlanResult | InviteValidationError;

/** Pure. No I/O — mirrors `planRosterImport`'s plan-then-commit split. */
export function planInvite(input: {
  email: string;
  displayName: string;
  tzOffsetMinutes: number;
  cohortId: string;
  role: string;
  capacity?: number;
  orgId?: string;
}): PlanInviteResult {
  const parsed = InviteInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? ""),
        message: issue.message,
      })),
    };
  }
  const data = parsed.data;
  return {
    ok: true,
    plan: {
      email: data.email,
      displayName: data.displayName,
      tzOffsetMinutes: data.tzOffsetMinutes,
      cohortId: data.cohortId,
      role: data.role,
      capacity: data.capacity ?? null,
      orgId: data.orgId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitInviteResult {
  participantId: string;
  /** False the first time; true when this email/cohort/role was already invited or enrolled — a no-op, not an error. */
  alreadyInvited: boolean;
  /**
   * The participant's state after the commit — `"invited"` for a new invite,
   * whatever it already was for a repeat. A caller deciding whether to
   * (re)send a sign-in link needs to tell "still waiting on them" from
   * "already enrolled" without a second read.
   */
  state: string;
}

export async function commitInvite(
  plan: InvitePlan,
  sink: EnrollmentSink,
  audit?: AuditSink,
  /** Who sent the invite, for the audit row — the admin's user id when an HTTP route knows it. */
  options: { actorRef?: string | null } = {},
): Promise<CommitInviteResult> {
  const { userId } = await sink.upsertUser({
    email: plan.email,
    displayName: plan.displayName,
    tzOffsetMinutes: plan.tzOffsetMinutes,
  });

  const existing = await sink.findParticipant({
    cohortId: plan.cohortId,
    userId,
    role: plan.role,
  });
  if (existing) {
    // Already "enrolled" or already "invited" — either way, re-inviting is a
    // dedupe case, not an error, mirroring how a repeated roster row is
    // skipped rather than rejected.
    return {
      participantId: existing.participantId,
      alreadyInvited: true,
      state: existing.state,
    };
  }

  const { participantId } = await sink.createParticipant({
    cohortId: plan.cohortId,
    userId,
    role: plan.role,
    capacity: plan.capacity,
    state: "invited",
  });

  if (audit) {
    await audit.record({
      orgId: plan.orgId ?? "",
      actorType: "admin",
      actorRef: options.actorRef ?? null,
      action: "participant.invited",
      subjectRef: `participant:${participantId}`,
      after: { userId, cohortId: plan.cohortId, role: plan.role, state: "invited" },
    });
  }

  return { participantId, alreadyInvited: false, state: "invited" };
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------

/**
 * The verification step. The actual authentication mechanics (proving control
 * of an email, a Slack account, whatever `provider` is) belong to a separate
 * auth flow — this just takes the already-verified identity as given and
 * records it, the same "resolvers read, sagas mutate through effects" split
 * used everywhere else in this codebase: `acceptInvite` does not authenticate
 * anyone, it commits the fact that authentication already happened.
 */
export async function acceptInvite(
  input: {
    participantId: string;
    userId: string;
    provider: string;
    externalId: string;
    now: () => string;
    orgId?: string;
  },
  sink: EnrollmentSink,
  audit?: AuditSink,
): Promise<void> {
  const verifiedAt = input.now();
  await sink.linkIdentity({
    userId: input.userId,
    provider: input.provider,
    externalId: input.externalId,
    verifiedAt,
  });
  await sink.updateParticipantState({
    participantId: input.participantId,
    state: "enrolled",
  });

  if (audit) {
    await audit.record({
      orgId: input.orgId ?? "",
      actorType: "user",
      actorRef: input.userId,
      action: "identity.verified",
      subjectRef: `participant:${input.participantId}`,
      after: {
        provider: input.provider,
        externalId: input.externalId,
        verifiedAt,
        state: "enrolled",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Accept on sign-in
// ---------------------------------------------------------------------------

/**
 * The read `acceptPendingInvites` needs on top of `EnrollmentSink`: every
 * participant row for this user still waiting on them. Kept a separate port
 * so the existing `EnrollmentSink` shape (and every fake of it) is unchanged.
 */
export interface PendingInviteSource {
  listInvitedParticipants(input: {
    userId: string;
  }): Promise<{ participantId: string }[]>;
}

/**
 * The provider recorded for an identity proven by clicking a magic link sent
 * to that address. Not one of the chat/calendar providers `identity_links`
 * was first written for — it is the *email* that has been verified, which is
 * what an invite is addressed to. Linking a Slack member id or a calendar
 * account is a separate, later verification (it needs that vendor's own
 * sign-in), and this deliberately does not pretend to do it.
 */
export const EMAIL_IDENTITY_PROVIDER = "email";

/**
 * Called once a person has proven control of `email` (today: consumed a
 * magic link sent to it). Every cohort invite still `"invited"` for them is
 * accepted through `acceptInvite`, so each gets its own `identity.verified`
 * audit row. Idempotent: a second sign-in finds nothing pending and does
 * nothing, which is what makes it safe for a caller to run best-effort after
 * a login and simply retry on the next one if it failed.
 */
export async function acceptPendingInvites(
  input: {
    userId: string;
    email: string;
    now: () => string;
    orgId?: string;
  },
  sink: EnrollmentSink & PendingInviteSource,
  audit?: AuditSink,
): Promise<{ accepted: string[] }> {
  const pending = await sink.listInvitedParticipants({ userId: input.userId });
  const accepted: string[] = [];
  for (const { participantId } of pending) {
    await acceptInvite(
      {
        participantId,
        userId: input.userId,
        provider: EMAIL_IDENTITY_PROVIDER,
        externalId: input.email.trim().toLowerCase(),
        now: input.now,
        ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      },
      sink,
      audit,
    );
    accepted.push(participantId);
  }
  return { accepted };
}
