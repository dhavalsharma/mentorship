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

export type VerifyFailureReason = "not_found" | "expired" | "already_used";

/** The body `/orgs/:orgId/settings/document` returns and accepts. */
export interface DocumentSettings {
  folderId: string | null;
  guidelineDocId: string | null;
  namingTemplate: string;
}
