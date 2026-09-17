import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Every table carries `org_id` and is protected by a row-level security policy
 * (see migrations/0001_init.sql). Retrofitting tenancy is the most expensive
 * migration in a system this shape, so it is here from the first commit.
 */

const orgScoped = {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const programs = pgTable("programs", {
  ...orgScoped,
  name: text("name").notNull(),
  /** The ProgramPolicy document — roles, cadence, agreement, integrations. */
  policy: jsonb("policy").notNull(),
});

export const cohorts = pgTable(
  "cohorts",
  {
    ...orgScoped,
    programId: uuid("program_id").notNull(),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("open"),
    /** Narrower cadence than the program, wider than the pair. */
    cadenceOverride: jsonb("cadence_override"),
  },
  (t) => [index("cohorts_program_idx").on(t.orgId, t.programId)],
);

export const users = pgTable(
  "users",
  {
    ...orgScoped,
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    tzOffsetMinutes: integer("tz_offset_minutes").notNull().default(0),
  },
  (t) => [uniqueIndex("users_org_email_idx").on(t.orgId, t.email)],
);

/**
 * Identity mapping, kept explicit and verified. Matching a Slack member to a
 * participant by email similarity works right up until it puts the wrong
 * person in a private pair thread.
 */
export const identityLinks = pgTable(
  "identity_links",
  {
    ...orgScoped,
    userId: uuid("user_id").notNull(),
    /** 'slack' | 'teams' | 'google' | 'microsoft' */
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("identity_links_unique").on(
      t.orgId,
      t.provider,
      t.externalId,
    ),
    index("identity_links_user_idx").on(t.orgId, t.userId),
  ],
);

export const participants = pgTable(
  "participants",
  {
    ...orgScoped,
    cohortId: uuid("cohort_id").notNull(),
    userId: uuid("user_id").notNull(),
    /** Program-defined string, not an enum: a person may mentor here and be mentored there. */
    role: text("role").notNull(),
    capacity: integer("capacity"),
    state: text("state").notNull().default("enrolled"),
  },
  (t) => [
    uniqueIndex("participants_unique").on(
      t.orgId,
      t.cohortId,
      t.userId,
      t.role,
    ),
  ],
);

export const profileAttributes = pgTable(
  "profile_attributes",
  {
    ...orgScoped,
    participantId: uuid("participant_id").notNull(),
    key: text("key").notNull(),
    /** 'enum' | 'scalar' | 'skill_level' | 'availability' | 'narrative' */
    type: text("type").notNull(),
    value: jsonb("value").notNull(),
    /** Only `narrative` attributes get embedded. */
    embedding: text("embedding"),
  },
  (t) => [
    uniqueIndex("profile_attributes_unique").on(
      t.orgId,
      t.participantId,
      t.key,
    ),
  ],
);

export const pairings = pgTable(
  "pairings",
  {
    ...orgScoped,
    cohortId: uuid("cohort_id").notNull(),
    mentorParticipantId: uuid("mentor_participant_id").notNull(),
    menteeParticipantId: uuid("mentee_participant_id").notNull(),
    state: text("state").notNull().default("proposed"),
    /** 'imported' | 'manual' | 'matched' | 'self_select' — matching is optional. */
    origin: text("origin").notNull(),
    /** Order-independent dedupe key, so a re-uploaded roster does not double up. */
    pairKey: text("pair_key").notNull(),
    /** The frequency this pair actually agreed to. */
    cadenceOverride: jsonb("cadence_override"),
    /** Conversation thread and shared document, resolved once and reused. */
    threadRef: jsonb("thread_ref"),
    documentRef: text("document_ref"),
    lastSessionAt: timestamp("last_session_at", { withTimezone: true }),
    importFileHash: text("import_file_hash"),
    notes: text("notes"),
    endedReason: text("ended_reason"),
  },
  (t) => [
    uniqueIndex("pairings_pair_key_unique").on(t.orgId, t.cohortId, t.pairKey),
    index("pairings_state_idx").on(t.orgId, t.cohortId, t.state),
  ],
);

/** Persisted for every considered pair, not just the winner — appeals need it. */
export const matchCandidates = pgTable(
  "match_candidates",
  {
    ...orgScoped,
    cohortId: uuid("cohort_id").notNull(),
    mentorParticipantId: uuid("mentor_participant_id").notNull(),
    menteeParticipantId: uuid("mentee_participant_id").notNull(),
    score: real("score").notNull(),
    features: jsonb("features").notNull(),
    explanation: text("explanation"),
    caveats: jsonb("caveats"),
    promptVersion: text("prompt_version"),
  },
  (t) => [index("match_candidates_cohort_idx").on(t.orgId, t.cohortId)],
);

export const agreements = pgTable("agreements", {
  ...orgScoped,
  pairingId: uuid("pairing_id").notNull(),
  subject: text("subject").notNull(),
  options: jsonb("options").notNull(),
  participantIds: jsonb("participant_ids").notNull(),
  responses: jsonb("responses").notNull().default([]),
  round: integer("round").notNull().default(1),
  resolution: text("resolution"),
  timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    ...orgScoped,
    pairingId: uuid("pairing_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("scheduled"),
    /** 'manual' | 'calendar' | 'inferred' */
    source: text("source").notNull().default("calendar"),
    calendarAdapterId: text("calendar_adapter_id"),
    calendarEventId: text("calendar_event_id"),
    conferenceUrl: text("conference_url"),
    transcriptionEnabled: boolean("transcription_enabled")
      .notNull()
      .default(false),
  },
  (t) => [index("sessions_pairing_idx").on(t.orgId, t.pairingId, t.startsAt)],
);

/** Raw, untrusted, never mutated by extraction. */
export const sessionNotes = pgTable("session_notes", {
  ...orgScoped,
  sessionId: uuid("session_id").notNull(),
  /** 'transcript' | 'typed' | 'upload' */
  kind: text("kind").notNull(),
  authorParticipantId: uuid("author_participant_id"),
  externalRef: text("external_ref"),
  body: text("body").notNull(),
});

export const extractions = pgTable("extractions", {
  ...orgScoped,
  sessionId: uuid("session_id").notNull(),
  sourceNoteId: uuid("source_note_id").notNull(),
  /** 'pending' | 'confirmed' | 'edited' | 'confirmed_unverified' */
  state: text("state").notNull().default("pending"),
  payload: jsonb("payload").notNull(),
  promptVersion: text("prompt_version"),
  confirmedBy: jsonb("confirmed_by").notNull().default({}),
});

export const actionItems = pgTable(
  "action_items",
  {
    ...orgScoped,
    pairingId: uuid("pairing_id").notNull(),
    sessionId: uuid("session_id"),
    ownerParticipantId: uuid("owner_participant_id").notNull(),
    text: text("text").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    state: text("state").notNull().default("open"),
    /** Character range into the source note — every claim stays checkable. */
    evidence: jsonb("evidence"),
  },
  (t) => [index("action_items_open_idx").on(t.orgId, t.pairingId, t.state)],
);

export const goals = pgTable("goals", {
  ...orgScoped,
  pairingId: uuid("pairing_id").notNull(),
  menteeParticipantId: uuid("mentee_participant_id").notNull(),
  outcome: text("outcome").notNull(),
  measure: text("measure"),
  baseline: text("baseline"),
  target: text("target"),
  horizonAt: timestamp("horizon_at", { withTimezone: true }),
  state: text("state").notNull().default("active"),
});

export const goalCheckins = pgTable("goal_checkins", {
  ...orgScoped,
  goalId: uuid("goal_id").notNull(),
  sessionId: uuid("session_id"),
  direction: text("direction").notNull(),
  note: text("note"),
  evidence: jsonb("evidence"),
});

/** One read surface for health, risk and dashboards. */
export const signals = pgTable(
  "signals",
  {
    ...orgScoped,
    subjectRef: text("subject_ref").notNull(),
    kind: text("kind").notNull(),
    value: numeric("value").notNull(),
    confidence: real("confidence").notNull().default(1),
    source: text("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("signals_subject_idx").on(t.orgId, t.subjectRef, t.kind, t.observedAt),
  ],
);

export const nudges = pgTable(
  "nudges",
  {
    ...orgScoped,
    pairingId: uuid("pairing_id"),
    recipientParticipantId: uuid("recipient_participant_id").notNull(),
    channel: text("channel").notNull(),
    /** 'planned' | 'sent' | 'dropped' */
    state: text("state").notNull().default("planned"),
    escalationLevel: integer("escalation_level").notNull().default(0),
    body: text("body").notNull(),
    /** The thing you cannot retrofit after you have already spammed someone. */
    dedupeKey: text("dedupe_key").notNull(),
    droppedReason: text("dropped_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("nudges_dedupe_unique").on(t.orgId, t.dedupeKey)],
);

/** Append-only. Written in the same transaction as the state change. */
export const events = pgTable(
  "events",
  {
    ...orgScoped,
    name: text("name").notNull(),
    subjectRef: text("subject_ref").notNull(),
    version: integer("version").notNull().default(1),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Outbox relay bookkeeping. */
    relayedAt: timestamp("relayed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** Backoff: the relay ignores a row until this passes. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    /**
     * Parked after too many failures. A subscriber that throws must never
     * block the events behind it, and must never be retried forever either.
     */
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  },
  (t) => [
    index("events_subject_idx").on(t.orgId, t.subjectRef, t.occurredAt),
    index("events_relay_idx").on(t.relayedAt),
    index("events_pending_idx").on(t.relayedAt, t.deadLetteredAt, t.occurredAt),
    /**
     * Slack redelivery dedupe, enforced by the database rather than by a
     * SELECT-then-INSERT that READ COMMITTED lets two transactions both pass
     * (migration 0011). Partial on `name`: only `notes.submitted` carries a
     * `noteId`, and every other event must stay free to repeat.
     */
    uniqueIndex("events_note_submitted_unique")
      .on(t.orgId, t.subjectRef, sql`(${t.payload} ->> 'noteId')`)
      .where(sql`${t.name} = 'notes.submitted'`),
  ],
);

/** Written before the first model call, so prompt versioning is never a retrofit. */
export const aiRuns = pgTable(
  "ai_runs",
  {
    ...orgScoped,
    primitive: text("primitive").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    inputHash: text("input_hash").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: numeric("cost_usd"),
    latencyMs: integer("latency_ms"),
    /** The human's answer — your best eval label. */
    verdict: text("verdict"),
    error: text("error"),
  },
  (t) => [index("ai_runs_primitive_idx").on(t.orgId, t.primitive, t.createdAt)],
);

/**
 * Rules-plus-trend findings from `packages/primitives/progress` (ADR-0007).
 * A row per finding rather than a queue table, deliberately: the queue this
 * feeds does not exist yet, and a findings log an admin view can filter is a
 * smaller, more honest commitment than a workflow this schema cannot see.
 */
export const riskFindings = pgTable(
  "risk_findings",
  {
    ...orgScoped,
    pairingId: uuid("pairing_id").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    summary: text("summary").notNull(),
    requiresHuman: boolean("requires_human").notNull().default(false),
    evidence: jsonb("evidence").notNull().default([]),
    /** Set once a human has looked at it. Null means still open. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => [
    index("risk_findings_pairing_idx").on(t.orgId, t.pairingId, t.detectedAt),
    index("risk_findings_open_idx").on(t.orgId, t.requiresHuman, t.acknowledgedAt),
  ],
);

/** How a three-day wait for two humans survives a deploy. */
export const sagaInstances = pgTable(
  "saga_instances",
  {
    ...orgScoped,
    sagaName: text("saga_name").notNull(),
    subjectRef: text("subject_ref").notNull(),
    state: jsonb("state").notNull(),
    awaitingEvent: jsonb("awaiting_event"),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    stepIndex: integer("step_index").notNull().default(0),
    /** Effect keys already executed — a retry is a no-op, not a second invite. */
    completedEffects: jsonb("completed_effects").notNull().default({}),
    history: jsonb("history").notNull().default([]),
    status: text("status").notNull().default("running"),
  },
  (t) => [
    index("saga_due_idx").on(t.status, t.timeoutAt),
    index("saga_subject_idx").on(t.orgId, t.sagaName, t.subjectRef),
  ],
);

/** Which adapter fills each slot, and what it was PROBED to be able to do. */
export const integrationBindings = pgTable(
  "integration_bindings",
  {
    ...orgScoped,
    slot: text("slot").notNull(),
    adapterId: text("adapter_id").notNull(),
    credentialsRef: text("credentials_ref"),
    capabilities: jsonb("capabilities"),
    /** Vendor-specific settings the adapter parses itself — see migration 0010. */
    config: jsonb("config").notNull().default({}),
    probedAt: timestamp("probed_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("integration_bindings_slot").on(t.orgId, t.slot)],
);

/**
 * Recording consent is tracked separately from AI-processing consent: they are
 * different acts, and revoking the first has to change future invites rather
 * than only what gets extracted.
 */
export const consents = pgTable(
  "consents",
  {
    ...orgScoped,
    participantId: uuid("participant_id").notNull(),
    /** 'ai_processing' | 'recording' */
    kind: text("kind").notNull(),
    granted: boolean("granted").notNull().default(false),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    evidence: text("evidence"),
  },
  (t) => [
    uniqueIndex("consents_unique").on(t.orgId, t.participantId, t.kind),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    ...orgScoped,
    actorType: text("actor_type").notNull(),
    actorRef: text("actor_ref"),
    action: text("action").notNull(),
    subjectRef: text("subject_ref").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    promptVersion: text("prompt_version"),
  },
  (t) => [index("audit_subject_idx").on(t.orgId, t.subjectRef, t.createdAt)],
);

/** Re-uploading the same sheet is the normal case, so record what was seen. */
export const rosterImports = pgTable("roster_imports", {
  ...orgScoped,
  cohortId: uuid("cohort_id").notNull(),
  fileHash: text("file_hash").notNull(),
  fileName: text("file_name"),
  uploadedBy: uuid("uploaded_by"),
  plan: jsonb("plan").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  result: jsonb("result"),
});

export const feedback = pgTable(
  "feedback",
  {
    ...orgScoped,
    sessionId: uuid("session_id").notNull(),
    participantId: uuid("participant_id").notNull(),
    score: integer("score"),
    comment: text("comment"),
  },
  (t) => [
    uniqueIndex("feedback_unique").on(t.orgId, t.sessionId, t.participantId),
  ],
);

/**
 * Magic-link login tokens. `tokenHash` is a sha256 of the raw token that was
 * emailed to the user — the raw token itself is never persisted, so a leaked
 * database dump cannot hand out working login tokens. `consumedAt` null means
 * the link is still usable; a link is single-use, so verifying it sets this.
 */
export const magicLinks = pgTable(
  "magic_links",
  {
    ...orgScoped,
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("magic_links_token_idx").on(t.orgId, t.tokenHash),
    index("magic_links_user_idx").on(t.orgId, t.userId, t.createdAt),
  ],
);

/** A session issued once a magic link is successfully verified. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    ...orgScoped,
    userId: uuid("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("auth_sessions_user_idx").on(t.orgId, t.userId, t.createdAt)],
);

export const schema = {
  organizations,
  programs,
  cohorts,
  users,
  identityLinks,
  participants,
  profileAttributes,
  pairings,
  matchCandidates,
  agreements,
  sessions,
  sessionNotes,
  extractions,
  actionItems,
  goals,
  goalCheckins,
  signals,
  nudges,
  events,
  aiRuns,
  riskFindings,
  sagaInstances,
  integrationBindings,
  consents,
  auditLog,
  rosterImports,
  feedback,
  magicLinks,
  authSessions,
};
