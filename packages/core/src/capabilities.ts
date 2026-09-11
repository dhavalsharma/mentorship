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
    idempotencyKey: string;
  }): Promise<{ docRef: string; url: string; revisionId: string }>;
}
