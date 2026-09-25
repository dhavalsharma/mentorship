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
    /**
     * When present, the adapter offers a "session preferences" control for
     * this pairing. Its answer is a structured choice (invariant 9), so an
     * adapter without `interactiveApproval` simply omits it.
     */
    preferencesPairingId?: string;
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

/**
 * The `sheet` slot: a periodic reporting destination, not a per-pair
 * artifact like `document`. One spreadsheet per org, one tab per report
 * type, full-overwrite on every sync (see `apps/worker/src/reports.ts` for
 * why append/dedupe was rejected). Modeled directly on `DocumentAdapter`
 * above — same two-call shape (locate-or-create, then write) — because the
 * underlying problem is the same one: a vendor-agnostic contract that must
 * never leak the word "spreadsheet ID" or "tab" as anything but an opaque
 * string core cares nothing about.
 */
export interface SheetAdapter extends Adapter {
  slot: "sheet";
  /**
   * Locates the destination spreadsheet, creating one (inside whatever
   * folder-equivalent the adapter's own config names) only when
   * `spreadsheetId` is `null`.
   *
   * `idempotencyKey` is here for the same reason `renderManagedRegion` on
   * `DocumentAdapter` takes one: every write-effect port carries it, so the
   * engine can pass `ctx.key` uniformly (invariant 6's "belt and braces"),
   * and an adapter backed by a vendor API that *can* dedupe by key (like
   * `FakeCalendar`) does. Neither Drive nor Sheets accepts an idempotency
   * key, though. `GoogleDriveDocumentAdapter.createDoc` works around that by
   * tagging the file with the key (`appProperties`) in the create call and
   * looking the key up first; `GoogleSheetsAdapter` still falls back to
   * adopting an existing file of the same name, a narrower guarantee (two
   * concurrent callers racing before either has created anything can still
   * each create one) that is tolerable for one spreadsheet per org and would
   * not be for one doc per pair. Do not read this signature as promising
   * more than that.
   */
  ensureSpreadsheet(input: {
    spreadsheetId: string | null;
    title: string;
    idempotencyKey: string;
  }): Promise<{ spreadsheetId: string; url: string }>;
  /**
   * Creates the tab if it does not exist, then replaces its entire used
   * range with `columns` (the header row) followed by `rows` — a full
   * overwrite, never an append. A report tab is a live snapshot of "what is
   * true right now"; append/dedupe would need a stable row key and a sheet
   * that only ever grows, which nothing here needs.
   */
  writeTab(input: {
    spreadsheetId: string;
    tabTitle: string;
    columns: string[];
    rows: unknown[][];
    idempotencyKey: string;
  }): Promise<void>;
}
