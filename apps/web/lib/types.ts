/**
 * Mirrors the row shapes Drizzle serializes for `risk_findings` and `nudges`
 * (see `packages/db/src/schema.ts`). Kept local to this app rather than
 * imported from `@mentorship/db` — this app never touches the database
 * directly, only the JSON the API already serialized, and its concern is
 * "what does the response body look like," not the storage schema.
 */

export interface RiskFinding {
  id: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
  pairingId: string;
  code: string;
  severity: string;
  detectedAt: string;
  summary: string;
  requiresHuman: boolean;
  evidence: unknown[];
  acknowledgedAt: string | null;
}

export interface Nudge {
  id: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
  pairingId: string | null;
  recipientParticipantId: string;
  channel: string;
  state: string;
  escalationLevel: number;
  body: string;
  dedupeKey: string;
  droppedReason: string | null;
  sentAt: string | null;
}

/**
 * Mirrors `saga_instances` (`packages/db/src/schema.ts`) — the ROADMAP
 * phase 1 monitoring gap's "stuck" half. Only ever `running` rows are
 * returned by the API (a `done`/`failed` instance can't be stuck), but the
 * column itself is free text, same reasoning as `Nudge.state` above.
 */
export interface StuckSagaInstance {
  id: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
  sagaName: string;
  subjectRef: string;
  state: Record<string, unknown>;
  status: string;
  stepIndex: number;
  version: number;
  timeoutAt: string | null;
}

/**
 * Mirrors `events` (`packages/db/src/schema.ts`) — the dead-letter half of
 * the same gap. Only rows with `deadLetteredAt` set are ever returned.
 */
export interface DeadLetteredEvent {
  id: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  subjectRef: string;
  occurredAt: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: string | null;
}

export type VerifyFailureReason = "not_found" | "expired" | "already_used";

/** The body `/orgs/:orgId/settings/document` returns and accepts. */
export interface DocumentSettings {
  folderId: string | null;
  guidelineDocId: string | null;
  namingTemplate: string;
}

/**
 * Mirrors `CandidateRecord` from `@mentorship/primitive-matching`, plus
 * `won` — the one field the read model adds that the persisted record does
 * not carry itself (see `getMatchingRoundCandidates` in
 * `apps/api/src/postgres-reads.ts`). Kept local rather than imported from
 * that package for the same reason `RiskFinding`/`Nudge` are: this app's
 * concern is the response body's shape, not the primitive's internal types.
 */
export interface MatchingRoundCandidate {
  menteeId: string;
  mentorId: string;
  eligible: boolean;
  violations: string[];
  features: Record<string, number>;
  explanations: Record<string, string>;
  deterministicScore: number;
  adjustment: number;
  adjustedScore: number;
  rank: number;
  shortlisted: boolean;
  rationale: string | null;
  riskFlags: string[];
  evidence: unknown[];
  won: boolean;
}

/** The body `/orgs/:orgId/matching-rounds/:runId/candidates` returns. */
export interface MatchingRoundCandidates {
  runId: string;
  cohortId: string;
  asOf: string;
  createdAt: string;
  candidates: MatchingRoundCandidate[];
}
