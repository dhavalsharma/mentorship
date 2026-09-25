import type { Agreement } from "./agreement.js";
import type { AdapterCapabilities, Interval, SlotName } from "./capabilities.js";
import type { Cadence, ProgramPolicy } from "./policy.js";
import type { PairingOrigin, PairingState } from "./pairing.js";

/**
 * Deterministic, read-only context assembly — the same idea as a primitive's
 * `resolve()` step. Sagas read through this and mutate only through effects,
 * which is what keeps them testable without a database or a network.
 */

export interface PairParticipant {
  participantId: string;
  role: string;
  displayName: string;
  email: string;
  /** Conversation / DM member id. Verified mapping, never an email guess. */
  memberRef: string;
  /** Calendar account. Often, but not always, the same as `email`. */
  calendarRef: string;
  tzOffsetMinutes: number;
  consent: { aiProcessing: boolean; recording: boolean };
}

export interface PairContext {
  pairingId: string;
  orgId: string;
  title: string;
  state: PairingState;
  /** Imported and matched pairs are indistinguishable from here down. */
  origin: PairingOrigin;
  policy: ProgramPolicy;
  cadence: Cadence;
  participants: PairParticipant[];
  lastSessionAt: string | null;
  documentRef: string | null;
  /**
   * The org's guideline/playbook doc, if one is configured — the same doc each
   * pair's running doc is seeded from. Resolved to a link here rather than
   * fetched anywhere: participant-facing messages link to it, they never quote
   * it, so the saga needs a URL and not the contents.
   */
  playbookUrl: string | null;
}

export interface SagaResolvers {
  pairContext(pairingId: string): Promise<PairContext>;
  freeBusy(input: {
    calendarRefs: string[];
    window: Interval;
  }): Promise<Record<string, Interval[]>>;
  agreement(agreementId: string): Promise<Agreement | null>;
  /** Probed per tenant and cached on the binding — never assumed. */
  capabilities(slot: SlotName): Promise<AdapterCapabilities | null>;
}

/**
 * Where the raw text a session is extracted from is kept — today, the
 * transcript `fetch_transcript` pulled from the vendor. The Postgres
 * implementation is the `session_notes` table ("raw, untrusted, never mutated
 * by extraction"); testkit's `World` keeps a map.
 *
 * Why a store and not an event payload (e2e bug #9): the transcript used to
 * live in the effect runner's memory between the pass that fetched it and the
 * pass that extracted it, so a restarted worker extracted from an empty
 * string. Invariant 5 wants what the saga needs back to arrive as an event —
 * and it does: `transcript.available` carries the *reference*. The text
 * itself is written here, once, before that event is emitted.
 *
 * Rejected: carrying the text on `transcript.available` (as `notes.submitted`
 * carries its body). One line of code, but it copies a whole recorded
 * conversation into the append-only event log, the outbox and the step's
 * `pending_step` — the log is immutable by design, so nothing could ever
 * honour a consent withdrawal against it. A row here can be deleted.
 * Rejected: re-fetching from the vendor at extraction time. Keeps nothing on
 * our side, but makes extraction depend on a second vendor call succeeding
 * and on the vendor returning the same text, and leaves evidence spans
 * (invariant 18) pointing into a source we never retained.
 *
 * Writes come only from the effect runner, reads only from the effect runner:
 * the saga never sees transcript text at all.
 */
export interface SessionSourceStore {
  /** Idempotent on (sessionId, ref): a retried fetch stores nothing new. */
  recordTranscript(input: {
    sessionId: string;
    ref: string;
    body: string;
  }): Promise<void>;
  transcript(input: { sessionId: string; ref: string }): Promise<string | null>;
}
