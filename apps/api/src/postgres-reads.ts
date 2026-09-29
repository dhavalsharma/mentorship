import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  aiRuns,
  cohorts,
  events,
  nudges,
  pairings,
  participants,
  programs,
  riskFindings,
  users,
  withTenant,
  type Db,
} from "@mentorship/db";
import {
  listDeadLetteredEvents,
  listStuckSagaInstances,
} from "@mentorship/workflows/postgres";
import { MatchingOutputSchema } from "@mentorship/primitive-matching";
import type { CandidateRecord } from "@mentorship/primitive-matching";
import {
  parsePreferenceEvents,
  shapePairPreferenceChanges,
  type PairPreferenceChanges,
} from "./pair-preference-changes.js";

/**
 * Read-side queries for the admin GET routes. Deliberately separate from
 * `postgres-ports.ts`: those are the write ports the Slack route needs at
 * request time, these are read-only projections for an eventual dashboard.
 * Kept in `apps/api` rather than on the primitive sinks that write these
 * tables — the sinks are write-only by design; a read path belongs to the
 * surface that serves it.
 */

/**
 * `limit` arrives already clamped by the caller (`server.ts`'s route
 * matcher) — these functions trust it rather than re-validating, since the
 * HTTP-facing bound belongs with the other query-param handling.
 */

/** Open risk findings for an org — `requiresHuman` and not yet acknowledged, most recent first. */
export async function listOpenRiskFindings(
  db: Db,
  orgId: string,
  limit: number,
  role?: string,
): Promise<unknown[]> {
  return withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select()
        .from(riskFindings)
        .where(
          and(
            eq(riskFindings.orgId, orgId),
            eq(riskFindings.requiresHuman, true),
            isNull(riskFindings.acknowledgedAt),
          ),
        )
        .orderBy(desc(riskFindings.detectedAt))
        .limit(limit),
    role === undefined ? {} : { role },
  );
}

/** Recent nudge records for an org, most recently created first. */
export async function listRecentNudges(
  db: Db,
  orgId: string,
  limit: number,
  role?: string,
): Promise<unknown[]> {
  return withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select()
        .from(nudges)
        .where(eq(nudges.orgId, orgId))
        .orderBy(desc(nudges.createdAt))
        .limit(limit),
    role === undefined ? {} : { role },
  );
}

/**
 * Recent `pair.preferences_updated` events for an org, newest first — the
 * admin view ADR-0009 action 7 asks for. Read straight off the event log
 * rather than a projection: the log already holds every change, immutable
 * and ordered, and nothing else needs a table of them yet.
 *
 * `limit` bounds the events read, so a page with a malformed row among them
 * shows `limit - skipped` changes rather than reaching further back — the
 * `skipped` count says so. Names and the program default are resolved in
 * three batched lookups, never one per row, all inside the same
 * `withTenant` transaction (invariant 3).
 */
export async function listPairPreferenceChanges(
  db: Db,
  orgId: string,
  limit: number,
  role?: string,
): Promise<PairPreferenceChanges> {
  return withTenant(
    db,
    orgId,
    async (tx) => {
      const rows = await tx
        .select({ id: events.id, occurredAt: events.occurredAt, payload: events.payload })
        .from(events)
        .where(and(eq(events.orgId, orgId), eq(events.name, "pair.preferences_updated")))
        .orderBy(desc(events.occurredAt), desc(events.id))
        .limit(limit);
      const { valid, skipped } = parsePreferenceEvents(rows);
      if (valid.length === 0) return { changes: [], skipped };

      const pairingIds = [...new Set(valid.map((e) => e.payload.pairingId))];
      const pairingRows = await tx
        .select({
          id: pairings.id,
          cohortId: pairings.cohortId,
          mentorParticipantId: pairings.mentorParticipantId,
          menteeParticipantId: pairings.menteeParticipantId,
        })
        .from(pairings)
        .where(and(eq(pairings.orgId, orgId), inArray(pairings.id, pairingIds)));

      const participantIds = [
        ...new Set([
          ...valid.map((e) => e.payload.participantId),
          ...pairingRows.flatMap((p) => [p.mentorParticipantId, p.menteeParticipantId]),
        ]),
      ];
      const nameRows = await tx
        .select({ participantId: participants.id, displayName: users.displayName })
        .from(participants)
        .innerJoin(
          users,
          and(eq(users.orgId, participants.orgId), eq(users.id, participants.userId)),
        )
        .where(and(eq(participants.orgId, orgId), inArray(participants.id, participantIds)));

      const cohortIds = [...new Set(pairingRows.map((p) => p.cohortId))];
      const cohortRows =
        cohortIds.length === 0
          ? []
          : await tx
              .select({
                id: cohorts.id,
                cadenceOverride: cohorts.cadenceOverride,
                policy: programs.policy,
              })
              .from(cohorts)
              .innerJoin(
                programs,
                and(eq(programs.orgId, cohorts.orgId), eq(programs.id, cohorts.programId)),
              )
              .where(and(eq(cohorts.orgId, orgId), inArray(cohorts.id, cohortIds)));

      const changes = shapePairPreferenceChanges(valid, {
        pairings: new Map(pairingRows.map((p) => [p.id, p])),
        names: new Map(nameRows.map((n) => [n.participantId, n.displayName])),
        cohorts: new Map(
          cohortRows.map((c) => [c.id, { policy: c.policy, cadenceOverride: c.cadenceOverride }]),
        ),
      });
      return { changes, skipped };
    },
    role === undefined ? {} : { role },
  );
}

/**
 * Running saga instances stuck for more than `olderThanDays` — the query
 * side of the ROADMAP phase 1 monitoring gap. Thin wrapper over
 * `@mentorship/workflows/postgres`'s `listStuckSagaInstances`: the table it
 * reads (`saga_instances`) belongs to that package, not this one.
 */
export async function listStuckSagas(
  db: Db,
  orgId: string,
  limit: number,
  olderThanDays: number,
  role?: string,
): Promise<unknown[]> {
  return listStuckSagaInstances(db, orgId, {
    limit,
    olderThanDays,
    ...(role === undefined ? {} : { role }),
  });
}

/** Dead-lettered events for an org, most recently parked first. */
export async function listDeadLetters(
  db: Db,
  orgId: string,
  limit: number,
  role?: string,
): Promise<unknown[]> {
  return listDeadLetteredEvents(db, orgId, {
    limit,
    ...(role === undefined ? {} : { role }),
  });
}

/**
 * One matching candidate as the appeal UI needs it — every field the
 * `CandidateRecordSchema` already carries, plus `won`, which the schema
 * itself does not: whether this (mentee, mentor) pair is the one that
 * ended up in `output.assignments`. Computed here, at read time, rather
 * than stored on the candidate — `assignments` is the single source of
 * truth for who was actually matched, and duplicating that flag onto every
 * candidate row would be one more place for the two to drift apart.
 */
export interface MatchingRoundCandidate extends CandidateRecord {
  won: boolean;
}

export interface MatchingRoundCandidates {
  runId: string;
  cohortId: string;
  asOf: string;
  createdAt: string;
  candidates: MatchingRoundCandidate[];
}

/**
 * Every candidate — winners and losers alike — that a matching round
 * considered, for the "why wasn't I matched with X" appeal view. The round's
 * full `MatchingOutput` (including `candidates`, ADR-0007/invariant 18's
 * "keep the evidence") already round-trips into `ai_runs.output` via
 * `PostgresAiRunSink` (see `runMatchingRound` in
 * `packages/primitives/matching/src/round.ts`); this is the first reader.
 *
 * Returns `null` when the run does not exist for this org, or exists but is
 * not a matching run (wrong primitive, or an `output` that failed to parse —
 * a degraded/fallback run that never reached the model has none) — the route
 * turns that into a 404 rather than a 500, same spirit as the UUID-shape
 * check other admin routes do before ever reaching the query.
 */
export async function getMatchingRoundCandidates(
  db: Db,
  orgId: string,
  runId: string,
  role?: string,
): Promise<MatchingRoundCandidates | null> {
  return withTenant(
    db,
    orgId,
    async (tx) => {
      const rows = await tx
        .select()
        .from(aiRuns)
        .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.id, runId)))
        .limit(1);
      const row = rows[0];
      if (!row || row.primitive !== "matching.propose" || row.output === null) {
        return null;
      }

      const parsed = MatchingOutputSchema.safeParse(row.output);
      if (!parsed.success) return null;
      const output = parsed.data;

      const winners = new Set(
        output.assignments.map((a) => `${a.menteeId}::${a.mentorId}`),
      );

      return {
        runId: row.id,
        cohortId: output.cohortId,
        asOf: output.asOf,
        createdAt: row.createdAt.toISOString(),
        candidates: output.candidates.map((candidate) => ({
          ...candidate,
          won: winners.has(`${candidate.menteeId}::${candidate.mentorId}`),
        })),
      };
    },
    role === undefined ? {} : { role },
  );
}
