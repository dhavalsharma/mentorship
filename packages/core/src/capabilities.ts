import { z } from "zod";

/**
 * Eight integration slots. A program binds an adapter to each slot; the saga
 * asks what that adapter can actually do and degrades, rather than assuming
 * capability from the vendor's name.
 */
export const SLOT_NAMES = [
  "conversation",
  "dm",
  "calendar",
  "conferencing",
  "transcript",
  "document",
  "sheet",
  "dashboard",
] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

export const AdapterCapabilitiesSchema = z.object({
  /** Can hold a persistent per-pair thread, not just fire-and-forget sends. */
  threadedConversation: z.boolean().default(false),
  /** Buttons / structured responses. Without this we never infer consent from prose. */
  interactiveApproval: z.boolean().default(false),
  freeBusy: z.boolean().default(false),
  createEventWithConference: z.boolean().default(false),
  /** 'native' = provider transcribes; 'byo' = we must supply a bot; 'none'. */
  autoTranscription: z.enum(["native", "byo", "none"]).default("none"),
  /** Can we own a marker-delimited region of the document and re-render it? */
  anchoredDocEdits: z.boolean().default(false),
  /** 'verified' = we hold a confirmed mapping; 'email_guess' = we do not. */
  identityMapping: z.enum(["verified", "email_guess"]).default("email_guess"),
});

export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

export const NO_CAPABILITIES: AdapterCapabilities =
  AdapterCapabilitiesSchema.parse({});

export interface Adapter {
  readonly slot: SlotName;
  readonly id: string;
  /**
   * Probed, not declared. Entitlement for things like meeting transcription
   * varies by tenant edition and admin policy, so the binding caches the
   * result of asking rather than trusting the adapter type.
   */
  probe(): Promise<AdapterCapabilities>;
}

// ---------------------------------------------------------------------------
// Slot ports
// ---------------------------------------------------------------------------

export interface ThreadRef {
  adapterId: string;
  channelId: string;
  threadId: string | null;
  url?: string;
}

export interface ProposalOption {
  optionId: string;
  startsAt: string; // ISO 8601 UTC
  endsAt: string;
  label: string;
}

export interface ConversationAdapter extends Adapter {
  slot: "conversation";
  ensureThread(input: {
    pairingId: string;
    memberRefs: string[];
    title: string;
  }): Promise<ThreadRef>;
  postProposal(input: {
    thread: ThreadRef;
    agreementId: string;
    options: ProposalOption[];
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }>;
  /**
   * A separate method from `postMessage` for the same reason `postProposal` is
   * one: this message asks a human for a *decision*, and a decision is only
   * ever read back off a structured control. An adapter without
   * `interactiveApproval` still has to post something, but the verdict then has
   * to arrive some other structured way — never by reading "looks good" out of
   * a reply (invariant 9).
   */
  postConfirmation(input: {
    thread: ThreadRef;
    extractionId: string;
    docUrl: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }>;
  postMessage(input: {
    thread: ThreadRef;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }>;
}

export interface DmAdapter extends Adapter {
  slot: "dm";
  send(input: {
    memberRef: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }>;
}

export interface Interval {
  start: string;
  end: string;
}

export interface CalendarEventRef {
  adapterId: string;
  eventId: string;
  conferenceUrl?: string;
  transcriptionEnabled: boolean;
  htmlLink?: string;
}

export interface CalendarAdapter extends Adapter {
  slot: "calendar";
  freeBusy(input: {
    memberRefs: string[];
    window: Interval;
  }): Promise<Record<string, Interval[]>>;
  createEvent(input: {
    memberRefs: string[];
    start: string;
    end: string;
    title: string;
    description: string;
    withConference: boolean;
    withTranscription: boolean;
    idempotencyKey: string;
  }): Promise<CalendarEventRef>;
  getEvent(eventId: string): Promise<CalendarEventRef | null>;
}

export interface TranscriptAdapter extends Adapter {
  slot: "transcript";
  /** null means "not available yet" — the saga decides whether to keep waiting. */
  fetch(input: {
    calendarEventId: string;
  }): Promise<{ ref: string; text: string } | null>;
}

export interface DocumentAdapter extends Adapter {
  slot: "document";
  /**
   * Renders into a marker-delimited managed region. Everything outside the
   * markers belongs to the pair and is never touched.
   */
  renderManagedRegion(input: {
    docRef: string | null;
    title: string;
    markdown: string;
    /**
     * Who must be able to edit this doc. Plain emails, because every doc
     * backend with a sharing model has a different name for the rest of it —
     * a Drive permission, a Notion guest, a Confluence restriction — and none
     * of those belong in core (invariant 1). The adapter decides what
     * "can edit" means for its own vendor.
     */
    collaborators: { email: string }[];
    idempotencyKey: string;
  }): Promise<{
    docRef: string;
    url: string;
    revisionId: string;
    /**
     * True when this render found a human edit inside the managed region
     * (one not authored by our own service account) and preserved it instead
     * of overwriting it — see `resolveManagedRegionWrite` and ADR-0005. An
     * adapter that cannot tell revisions apart (no `anchoredDocEdits`,
     * effectively) always reports `false`.
     */
    pinned: boolean;
  }>;
}
