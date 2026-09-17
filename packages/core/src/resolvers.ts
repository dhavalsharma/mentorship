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
