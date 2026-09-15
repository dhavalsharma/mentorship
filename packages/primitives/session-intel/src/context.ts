import type { PairContext } from "@mentorship/core";

/**
 * The trigger, the resolved context and the reader the primitive reads
 * through. `resolve` is pure data assembly — no model, no network beyond the
 * reader — which is the part to fix first when quality is bad.
 */

export type SessionSourceKind = "transcript" | "notes" | "chat";

export interface SessionIntelTrigger {
  sessionId: string;
  pairingId: string;
  /** Where the text came from, e.g. `transcript:zoom:abc` — kept for audit. */
  sourceRef: string;
  sourceKind: SessionSourceKind;
  /**
   * The **unedited** source. Every evidence span offsets into exactly this
   * string, so a span can be checked against what the participants actually
   * wrote rather than against something we tidied first.
   */
  text: string;
  occurredAt?: string;
}

/** A goal as the pair sees it. Refs come from context; the model invents none. */
export interface GoalRef {
  goalRef: string;
  title: string;
}

/**
 * Narrow by design: the primitive reads a pair and (optionally) its goals,
 * nothing else. `SagaResolvers` satisfies this structurally, so a saga can
 * hand its own resolvers straight in without either side importing `db`.
 */
export interface SessionIntelReader {
  pairContext(pairingId: string): Promise<PairContext>;
  goals?(pairingId: string): Promise<GoalRef[]>;
}

export interface SessionIntelParticipant {
  participantId: string;
  role: string;
  displayName: string;
  /** False for anyone who has not consented to AI processing. */
  aiProcessing: boolean;
}

export interface SessionIntelContext {
  sessionId: string;
  pairingId: string;
  orgId: string;
  title: string;
  sourceRef: string;
  sourceKind: SessionSourceKind;
  /** The unedited text. Spans index into this and nothing else. */
  source: string;
  participants: SessionIntelParticipant[];
  goals: GoalRef[];
  /**
   * Every party must have consented for inference to run. Carried on the
   * context rather than checked at the call site so the decision is visible in
   * the hashed input of every `ai_runs` row.
   */
  inferenceAllowed: boolean;
}

export async function resolveSessionIntelContext(
  trigger: SessionIntelTrigger,
  reader: SessionIntelReader,
): Promise<SessionIntelContext> {
  const pair = await reader.pairContext(trigger.pairingId);
  const goals = reader.goals ? await reader.goals(trigger.pairingId) : [];

  const participants: SessionIntelParticipant[] = pair.participants.map((p) => ({
    participantId: p.participantId,
    role: p.role,
    displayName: p.displayName,
    aiProcessing: p.consent.aiProcessing,
  }));

  return {
    sessionId: trigger.sessionId,
    pairingId: pair.pairingId,
    orgId: pair.orgId,
    title: pair.title,
    sourceRef: trigger.sourceRef,
    sourceKind: trigger.sourceKind,
    source: trigger.text,
    participants,
    goals,
    // Consent is per-person and unanimous: one participant's refusal is not
    // outvoted by the other's agreement, because the text is about both.
    inferenceAllowed:
      participants.length > 0 && participants.every((p) => p.aiProcessing),
  };
}
