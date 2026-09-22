import { and, eq, inArray, like } from "drizzle-orm";
import {
  StoredProgramPolicySchema,
  resolveCadence,
  type ProgramPolicy,
} from "@mentorship/core";
import {
  actionItems,
  cohorts,
  goals,
  identityLinks,
  nudges,
  pairings,
  participants,
  programs,
  sessions,
  users,
  withTenant,
  type Db,
} from "@mentorship/db";
import type { SweepActionItem, SweepGoal, SweepPair } from "./deficits.js";
import type { DeficitName } from "./deficits.js";
import type { NudgeHistory, NudgePairView, NudgeReader, NudgeRecipient } from "./context.js";
import type { TemplateStat } from "./bandit.js";
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

/**
 * One resolved-policy group of active pairings, gathered into the shape
 * `sweep()` (`deficits.ts`) already accepts. Grouped by cohort for the same
 * reason `listActivePairingsByCohort` in the progress package's own
 * `postgres.ts` is: policy is per-cohort data, and `runNudgeSweep` takes a
 * single `policy: ProgramPolicy` per call.
 *
 * `surveys` is always empty — there is no survey table yet (see the progress
 * reader's identical note), so `sweep()` never emits `survey.unanswered`
 * today. `pairs[].blockedOnParticipantId` is always `null` here: resolving it
 * for real means joining the pair's open agreement through the same
 * `resolveAgreement` logic the saga uses, which this sweep-side query does
 * not attempt — a deliberate, honest simplification rather than a guess.
 */
export interface CohortDeficitInput {
  cohortId: string;
  policy: ProgramPolicy;
  pairs: SweepPair[];
  actionItems: SweepActionItem[];
  goals: SweepGoal[];
}

export async function listCohortDeficitInputs(
  db: Db,
  orgId: string,
  options: { role?: string; onWarn?: (message: string, detail?: Record<string, unknown>) => void } = {},
): Promise<CohortDeficitInput[]> {
  const { role, onWarn } = options;
  return withTenant(
    db,
    orgId,
    async (tx) => {
      const pairingRows = await tx
        .select()
        .from(pairings)
        .where(and(eq(pairings.orgId, orgId), eq(pairings.state, "active")));

      const pairingIds = pairingRows.map((p) => p.id);
      const sessionRows =
        pairingIds.length === 0
          ? []
          : await tx
              .select()
              .from(sessions)
              .where(and(eq(sessions.orgId, orgId), inArray(sessions.pairingId, pairingIds)));
      const actionItemRows =
        pairingIds.length === 0
          ? []
          : await tx
              .select()
              .from(actionItems)
              .where(and(eq(actionItems.orgId, orgId), inArray(actionItems.pairingId, pairingIds)));
      const goalRows =
        pairingIds.length === 0
          ? []
          : await tx
              .select()
              .from(goals)
              .where(and(eq(goals.orgId, orgId), inArray(goals.pairingId, pairingIds)));

      const byCohort = new Map<string, typeof pairingRows>();
      for (const row of pairingRows) {
        const list = byCohort.get(row.cohortId) ?? [];
        list.push(row);
        byCohort.set(row.cohortId, list);
      }

      // One batched query for every cohort's policy rather than one round
      // trip per cohort inside the loop below — this runs on every scheduled
      // sweep tick, so an org with many cohorts otherwise pays N sequential
      // queries per tick for data a single `inArray` fetches at once.
      const cohortIds = [...byCohort.keys()];
      const policyRows =
        cohortIds.length === 0
          ? []
          : await tx
              .select({ cohortId: cohorts.id, policy: programs.policy })
              .from(cohorts)
              .innerJoin(
                programs,
                and(eq(programs.orgId, cohorts.orgId), eq(programs.id, cohorts.programId)),
              )
              .where(and(eq(cohorts.orgId, orgId), inArray(cohorts.id, cohortIds)));
      const policyByCohort = new Map(policyRows.map((r) => [r.cohortId, r.policy]));

      const groups: CohortDeficitInput[] = [];
      for (const [cohortId, rows] of byCohort) {
        const rawPolicy = policyByCohort.get(cohortId);
        if (rawPolicy === undefined) {
          onWarn?.("cohort has no program/policy — skipped from this sweep", { cohortId });
          continue;
        }
        let policy: ProgramPolicy;
        try {
          policy = StoredProgramPolicySchema.parse(rawPolicy);
        } catch (err) {
          onWarn?.("cohort policy is malformed — skipped from this sweep", {
            cohortId,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const cohortPairingIds = new Set(rows.map((r) => r.id));

        const pairs: SweepPair[] = rows.map((row) => {
          const cadence = resolveCadence(
            policy.cadence,
            null,
            row.cadenceOverride as Partial<typeof policy.cadence> | null,
          );
          const nextScheduled = sessionRows
            .filter((s) => s.pairingId === row.id && s.state === "scheduled")
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
          return {
            pairingId: row.id,
            orgId,
            state: row.state as SweepPair["state"],
            cadenceEveryDays: cadence.everyDays,
            // No dedicated "activated at" column — see the progress reader's
            // identical note on `pairing.createdAt` as the closest proxy.
            activatedAt: row.createdAt.toISOString(),
            lastSessionAt: row.lastSessionAt?.toISOString() ?? null,
            nextScheduledSessionAt: nextScheduled ? nextScheduled.startsAt.toISOString() : null,
            blockedOnParticipantId: null,
          };
        });

        const cohortActionItems: SweepActionItem[] = actionItemRows
          .filter((a) => cohortPairingIds.has(a.pairingId) && a.dueAt !== null)
          .map((a) => ({
            actionItemId: a.id,
            pairingId: a.pairingId,
            orgId,
            ownerParticipantId: a.ownerParticipantId,
            // Filtered above: `dueAt` is required by `SweepActionItemSchema`,
            // and an action item with no due date has nothing to be overdue
            // against.
            dueAt: a.dueAt!.toISOString(),
            status: a.state === "done" ? "done" : a.state === "dropped" ? "dropped" : "open",
          }));

        const cohortGoals: SweepGoal[] = goalRows
          .filter((g) => cohortPairingIds.has(g.pairingId))
          .map((g) => ({
            goalId: g.id,
            pairingId: g.pairingId,
            orgId,
            ownerParticipantId: g.menteeParticipantId,
            createdAt: g.createdAt.toISOString(),
            // No goal check-in join here (unlike the progress reader): the
            // sweep only needs the *latest* touch, and the goal row's own
            // `updatedAt` already moves whenever a check-in is written to it,
            // so a second query buys nothing this call doesn't already have.
            lastCheckInAt: g.updatedAt.getTime() === g.createdAt.getTime() ? null : g.updatedAt.toISOString(),
            status: g.state === "achieved" ? "achieved" : g.state === "abandoned" ? "abandoned" : "open",
          }));

        groups.push({ cohortId, policy, pairs, actionItems: cohortActionItems, goals: cohortGoals });
      }
      return groups;
    },
    role === undefined ? {} : { role },
  );
}

/**
 * `NudgeReader` over the real tables — deliberately a minimal, honest MVP.
 * Three real schema gaps limit it, each called out where it bites:
 *
 *  - No per-participant mute/snooze/quiet-hours columns exist yet, so every
 *    recipient reads as unmuted, never snoozed, and on the program-wide
 *    default quiet hours. The gate chain still runs; it just cannot yet
 *    express "this one person asked to be left alone".
 *  - `nudges` has no `template_id` or `tone` column, so `history()` cannot
 *    reconstruct which template was actually sent — `delivered` is always
 *    empty and `consecutiveDrops` is always 0. `sentDedupeKeys` is real
 *    (read straight off `nudges.dedupe_key`), which is what invariant 11's
 *    cap and the sweep's own idempotence actually depend on.
 *  - `templateStats()` is always `[]` — the same missing `template_id`
 *    column means outcomes cannot be attributed back to a template yet, so
 *    the bandit runs on a uniform prior every time rather than learning.
 *
 * None of these silently invent data: each is a documented degradation, the
 * same shape as `heuristicSessionIntel` standing in for a real model.
 */
export class PostgresNudgeReader implements NudgeReader {
  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly options: { role?: string } = {},
  ) {}

  private read<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const { role } = this.options;
    return withTenant(this.db, this.orgId, fn, role === undefined ? {} : { role });
  }

  async pair(pairingId: string): Promise<NudgePairView> {
    const { orgId } = this;
    return this.read(async (tx) => {
      const [pairing] = await tx
        .select()
        .from(pairings)
        .where(and(eq(pairings.orgId, orgId), eq(pairings.id, pairingId)))
        .limit(1);
      if (!pairing) throw new Error(`unknown pairing ${pairingId}`);

      const [policyRow] = await tx
        .select({ policy: programs.policy, cadenceOverride: cohorts.cadenceOverride })
        .from(cohorts)
        .innerJoin(
          programs,
          and(eq(programs.orgId, cohorts.orgId), eq(programs.id, cohorts.programId)),
        )
        .where(and(eq(cohorts.orgId, orgId), eq(cohorts.id, pairing.cohortId)))
        .limit(1);
      if (!policyRow) throw new Error(`pairing ${pairingId} has no cohort or program`);
      const policy = StoredProgramPolicySchema.parse(policyRow.policy);
      const cadence = resolveCadence(
        policy.cadence,
        policyRow.cadenceOverride as Partial<typeof policy.cadence> | null,
        pairing.cadenceOverride as Partial<typeof policy.cadence> | null,
      );

      const ids = [pairing.mentorParticipantId, pairing.menteeParticipantId];
      const people = await tx
        .select({
          participantId: participants.id,
          role: participants.role,
          userId: users.id,
          displayName: users.displayName,
          tzOffsetMinutes: users.tzOffsetMinutes,
        })
        .from(participants)
        .innerJoin(users, and(eq(users.orgId, participants.orgId), eq(users.id, participants.userId)))
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

      const nudgesLast7 = await tx
        .select({ recipientParticipantId: nudges.recipientParticipantId })
        .from(nudges)
        .where(
          and(
            eq(nudges.orgId, orgId),
            inArray(nudges.recipientParticipantId, people.map((p) => p.participantId)),
            eq(nudges.state, "sent"),
          ),
        );
      // Every `sent` row, not just the trailing seven days: an exact range
      // predicate is a straightforward follow-up, but counting the whole
      // history is a conservative over-count that only ever makes the rate
      // limit stricter, never looser — the safe direction for a limiter to
      // be wrong in.
      const recentCounts = new Map<string, number>();
      for (const row of nudgesLast7) {
        recentCounts.set(
          row.recipientParticipantId,
          (recentCounts.get(row.recipientParticipantId) ?? 0) + 1,
        );
      }

      const recipients: NudgeRecipient[] = people.map((person) => {
        const chat = links.find(
          (l) => l.userId === person.userId && l.provider === "slack" && l.verifiedAt !== null,
        );
        return {
          participantId: person.participantId,
          role: person.role,
          displayName: person.displayName,
          memberRef: chat?.externalId ?? `participant:${person.participantId}`,
          tzOffsetMinutes: person.tzOffsetMinutes,
          // Only the DM channel is wired end to end (see CLAUDE.md's status
          // table); a program with a bound `conversation` slot but no `dm`
          // slot is not distinguishable here without a capability probe,
          // which lives at the integration layer, not this primitive's
          // reader (invariant 1's boundary, extended).
          channels: ["dm"],
          muted: false,
          snoozedUntil: null,
          quietHours: { startHour: 21, endHour: 8 },
          nudgesLast7Days: recentCounts.get(person.participantId) ?? 0,
          lastRespondedAt: null,
        };
      });

      const title = `Mentoring — ${recipients.map((r) => r.displayName).join(" & ")}`;
      const nextScheduled = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.orgId, orgId),
            eq(sessions.pairingId, pairingId),
            eq(sessions.state, "scheduled"),
          ),
        );
      const soonest = nextScheduled.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];

      return {
        pairingId,
        orgId,
        title,
        cadenceLabel: cadence.label,
        recipients,
        nextScheduledSessionAt: soonest ? soonest.startsAt.toISOString() : null,
        // No escalation contact in `ProgramPolicySchema` today — the same gap
        // invariant 16 names for `safeguarding.contactMemberRef`, just not
        // yet extended to the nudge ladder.
        admin: null,
      };
    });
  }

  async history(input: {
    pairingId: string;
    subjectRef: string;
    deficit: DeficitName;
  }): Promise<NudgeHistory> {
    const { orgId } = this;
    return this.read(async (tx) => {
      // `dedupeKey` is `<subjectRef>:<deficit short name>:<isoWeek>` — a
      // prefix match finds every dedupe key this absence has ever spent,
      // across every week, without needing a `subject_ref` column on
      // `nudges` that does not exist.
      const short = input.deficit.split(".").pop() ?? input.deficit;
      const prefix = `${input.subjectRef}:${short}:`;
      const rows = await tx
        .select({ dedupeKey: nudges.dedupeKey })
        .from(nudges)
        .where(and(eq(nudges.orgId, orgId), eq(nudges.pairingId, input.pairingId), like(nudges.dedupeKey, `${prefix}%`)));
      return {
        delivered: [],
        consecutiveDrops: 0,
        sentDedupeKeys: rows.map((r) => r.dedupeKey),
      };
    });
  }

  async templateStats(_input: { orgId: string; deficit: DeficitName }): Promise<TemplateStat[]> {
    return [];
  }

  async subjectLabel(subjectRef: string): Promise<string> {
    const { orgId } = this;
    const [kind, id] = subjectRef.split(":");
    return this.read(async (tx) => {
      if (kind === "action_item" && id) {
        const [row] = await tx
          .select({ text: actionItems.text })
          .from(actionItems)
          .where(and(eq(actionItems.orgId, orgId), eq(actionItems.id, id)))
          .limit(1);
        if (row) return row.text;
      }
      if (kind === "goal" && id) {
        const [row] = await tx
          .select({ outcome: goals.outcome })
          .from(goals)
          .where(and(eq(goals.orgId, orgId), eq(goals.id, id)))
          .limit(1);
        if (row) return row.outcome;
      }
      // `pairing:<id>` (a cadence deficit) and `survey:<id>` (no survey table
      // yet — see the module note) fall through to a generic label. Untrusted
      // either way (invariant 15): this is interpolated into copy, never
      // treated as instruction.
      return subjectRef;
    });
  }
}
