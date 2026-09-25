import type {
  AdapterCapabilities,
  CalendarAdapter,
  CalendarEventRef,
  ConversationAdapter,
  DmAdapter,
  DocumentAdapter,
  Interval,
  ProposalOption,
  SheetAdapter,
  ThreadRef,
  TranscriptAdapter,
} from "@mentorship/core";
import { AdapterCapabilitiesSchema, resolveManagedRegionWrite } from "@mentorship/core";

/**
 * In-memory adapters. These are what the test suite and the demo run on, and
 * they are deliberately complete rather than stubs: the whole point of the
 * capability model is that the saga behaves identically against a fake and
 * against Slack, so the fakes have to be honest about what they can do.
 *
 * Every adapter records its calls so a test can assert "we sent exactly one
 * reminder" and the demo can print a readable trace.
 */

export interface Recorded {
  kind: string;
  at: string;
  detail: Record<string, unknown>;
}

export class Recorder {
  readonly calls: Recorded[] = [];
  record(kind: string, detail: Record<string, unknown>): void {
    this.calls.push({ kind, at: new Date().toISOString(), detail });
  }
  of(kind: string): Recorded[] {
    return this.calls.filter((c) => c.kind === kind);
  }
}

const caps = (over: Partial<AdapterCapabilities>): AdapterCapabilities =>
  AdapterCapabilitiesSchema.parse(over);

// ---------------------------------------------------------------------------

export class FakeConversation implements ConversationAdapter {
  readonly slot = "conversation" as const;
  readonly id: string;
  private readonly threads = new Map<string, ThreadRef>();
  private readonly seen = new Set<string>();

  constructor(
    readonly recorder: Recorder,
    opts: { id?: string; interactiveApproval?: boolean } = {},
  ) {
    this.id = opts.id ?? "fake-chat";
    this.interactive = opts.interactiveApproval ?? true;
  }
  private readonly interactive: boolean;

  async probe(): Promise<AdapterCapabilities> {
    return caps({
      threadedConversation: true,
      interactiveApproval: this.interactive,
      identityMapping: "verified",
    });
  }

  async ensureThread(input: {
    pairingId: string;
    memberRefs: string[];
    title: string;
  }): Promise<ThreadRef> {
    const existing = this.threads.get(input.pairingId);
    if (existing) return existing;
    const ref: ThreadRef = {
      adapterId: this.id,
      channelId: `C-${input.pairingId}`,
      threadId: `T-${input.pairingId}`,
      url: `https://chat.example/${input.pairingId}`,
    };
    this.threads.set(input.pairingId, ref);
    this.recorder.record("thread.created", {
      pairingId: input.pairingId,
      members: input.memberRefs,
      title: input.title,
    });
    return ref;
  }

  async postProposal(input: {
    thread: ThreadRef;
    agreementId: string;
    options: ProposalOption[];
    body: string;
    idempotencyKey: string;
    preferencesPairingId?: string;
  }): Promise<{ messageRef: string }> {
    if (this.seen.has(input.idempotencyKey)) {
      return { messageRef: `dup:${input.idempotencyKey}` };
    }
    this.seen.add(input.idempotencyKey);
    this.recorder.record("thread.proposal", {
      channel: input.thread.channelId,
      agreementId: input.agreementId,
      options: input.options.map((o) => o.label),
      body: input.body,
      ...(input.preferencesPairingId
        ? { preferencesPairingId: input.preferencesPairingId }
        : {}),
    });
    return { messageRef: `msg_${this.seen.size}` };
  }

  async postConfirmation(input: {
    thread: ThreadRef;
    extractionId: string;
    docUrl: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }> {
    if (this.seen.has(input.idempotencyKey)) {
      return { messageRef: `dup:${input.idempotencyKey}` };
    }
    this.seen.add(input.idempotencyKey);
    this.recorder.record("thread.confirmation", {
      channel: input.thread.channelId,
      extractionId: input.extractionId,
      docUrl: input.docUrl,
      body: input.body,
    });
    return { messageRef: `msg_${this.seen.size}` };
  }

  async postMessage(input: {
    thread: ThreadRef;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }> {
    if (this.seen.has(input.idempotencyKey)) {
      return { messageRef: `dup:${input.idempotencyKey}` };
    }
    this.seen.add(input.idempotencyKey);
    this.recorder.record("thread.message", {
      channel: input.thread.channelId,
      body: input.body,
    });
    return { messageRef: `msg_${this.seen.size}` };
  }
}

// ---------------------------------------------------------------------------

export class FakeDm implements DmAdapter {
  readonly slot = "dm" as const;
  readonly id = "fake-dm";
  private readonly seen = new Set<string>();

  constructor(readonly recorder: Recorder) {}

  async probe(): Promise<AdapterCapabilities> {
    return caps({ identityMapping: "verified" });
  }

  async send(input: {
    memberRef: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }> {
    if (this.seen.has(input.idempotencyKey)) {
      return { messageRef: `dup:${input.idempotencyKey}` };
    }
    this.seen.add(input.idempotencyKey);
    this.recorder.record("dm.sent", { to: input.memberRef, body: input.body });
    return { messageRef: `dm_${this.seen.size}` };
  }
}

// ---------------------------------------------------------------------------

export class FakeCalendar implements CalendarAdapter {
  readonly slot = "calendar" as const;
  readonly id: string;
  private readonly events = new Map<string, CalendarEventRef>();
  private readonly byKey = new Map<string, string>();
  private counter = 0;

  constructor(
    readonly recorder: Recorder,
    private readonly busy: Record<string, Interval[]> = {},
    private readonly opts: {
      id?: string;
      freeBusy?: boolean;
      conference?: boolean;
    } = {},
  ) {
    this.id = opts.id ?? "fake-calendar";
  }

  async probe(): Promise<AdapterCapabilities> {
    return caps({
      freeBusy: this.opts.freeBusy ?? true,
      createEventWithConference: this.opts.conference ?? true,
      identityMapping: "verified",
    });
  }

  async freeBusy(input: {
    memberRefs: string[];
    window: Interval;
  }): Promise<Record<string, Interval[]>> {
    const out: Record<string, Interval[]> = {};
    for (const ref of input.memberRefs) {
      out[ref] = (this.busy[ref] ?? []).filter(
        (i) => i.end > input.window.start && i.start < input.window.end,
      );
    }
    return out;
  }

  async createEvent(input: {
    memberRefs: string[];
    start: string;
    end: string;
    title: string;
    description: string;
    withConference: boolean;
    withTranscription: boolean;
    idempotencyKey: string;
  }): Promise<CalendarEventRef> {
    // The reason effects are keyed: a retried step must not book twice.
    const already = this.byKey.get(input.idempotencyKey);
    if (already) return this.events.get(already)!;

    this.counter++;
    const eventId = `cal_${String(this.counter).padStart(3, "0")}`;
    const ref: CalendarEventRef = {
      adapterId: this.id,
      eventId,
      conferenceUrl: input.withConference
        ? `https://meet.example/${eventId}`
        : undefined,
      transcriptionEnabled: input.withTranscription,
      htmlLink: `https://calendar.example/${eventId}`,
    };
    this.events.set(eventId, ref);
    this.byKey.set(input.idempotencyKey, eventId);
    this.recorder.record("calendar.created", {
      eventId,
      start: input.start,
      end: input.end,
      attendees: input.memberRefs,
      conference: Boolean(ref.conferenceUrl),
      transcription: input.withTranscription,
    });
    return ref;
  }

  async getEvent(eventId: string): Promise<CalendarEventRef | null> {
    return this.events.get(eventId) ?? null;
  }

  /** Test hook: simulate someone deleting the invite out of band. */
  cancel(eventId: string): void {
    this.events.delete(eventId);
    this.recorder.record("calendar.cancelled", { eventId });
  }
}

// ---------------------------------------------------------------------------

export class FakeTranscript implements TranscriptAdapter {
  readonly slot = "transcript" as const;
  readonly id = "fake-transcript";
  private fetches = new Map<string, number>();

  constructor(
    readonly recorder: Recorder,
    private readonly opts: {
      autoTranscription?: "native" | "byo" | "none";
      /** Becomes available only on the Nth fetch, to exercise the backoff. */
      availableAfterFetches?: number;
      text?: string;
    } = {},
  ) {}

  async probe(): Promise<AdapterCapabilities> {
    return caps({ autoTranscription: this.opts.autoTranscription ?? "native" });
  }

  async fetch(input: {
    calendarEventId: string;
  }): Promise<{ ref: string; text: string } | null> {
    const n = (this.fetches.get(input.calendarEventId) ?? 0) + 1;
    this.fetches.set(input.calendarEventId, n);
    const threshold = this.opts.availableAfterFetches ?? 1;
    this.recorder.record("transcript.fetch", {
      eventId: input.calendarEventId,
      attempt: n,
      found: n >= threshold,
    });
    if (n < threshold) return null;
    return {
      ref: `transcript_${input.calendarEventId}`,
      text: this.opts.text ?? DEFAULT_TRANSCRIPT,
    };
  }
}

const DEFAULT_TRANSCRIPT = [
  "Priya: I've been stuck on whether to go for the tech lead opening.",
  "Arjun: What's holding you back?",
  "Priya: I've never run a project end to end, and the JD asks for it.",
  "Arjun: You ran the billing migration. That counts — write it up that way.",
  "Priya: Okay. I'll draft the internal application this week.",
  "Arjun: Send me the draft by Friday and I'll review it.",
  "Priya: Also I'd like to get better at estimating. It's my weakest area.",
  "Arjun: Let's make that the next session's topic.",
].join("\n");

// ---------------------------------------------------------------------------

export class FakeDocument implements DocumentAdapter {
  readonly slot = "document" as const;
  readonly id = "fake-doc";
  private revision = 0;
  private readonly docs = new Map<string, string>();
  private readonly shares = new Map<string, Set<string>>();
  // ADR-0005's two safeguards, kept per doc: what we last rendered ourselves
  // (the baseline pinning compares against) and who authored the region's
  // current content — "service" (us, most recently) or "human" (someone
  // edited it directly, via `humanEdit`/`simulateServiceEcho` below in
  // tests, or a real editor in the corresponding vendor adapter).
  private readonly lastRendered = new Map<string, string>();
  private readonly revisionAuthor = new Map<string, "service" | "human">();
  // Keyed renders already applied: which doc the key created or wrote, what
  // the doc held afterwards, and what the call returned. In-memory like
  // `FakeCalendar.byKey` — the real adapter keeps the create half of this on
  // the Drive file itself (`appProperties`), so it survives a restart.
  private readonly byKey = new Map<
    string,
    {
      docRef: string;
      content: string;
      result: { docRef: string; url: string; revisionId: string; pinned: boolean };
    }
  >();

  constructor(readonly recorder: Recorder) {}

  async probe(): Promise<AdapterCapabilities> {
    return caps({ anchoredDocEdits: true });
  }

  async renderManagedRegion(input: {
    docRef: string | null;
    title: string;
    markdown: string;
    collaborators: { email: string }[];
    idempotencyKey: string;
  }): Promise<{ docRef: string; url: string; revisionId: string; pinned: boolean }> {
    // Invariant 6, mirroring `GoogleDriveDocumentAdapter`: a doc is created
    // under its render's idempotency key, and a render with no doc id first
    // looks for a doc created under that key. That is exactly the retry a
    // crash between "vendor created the doc" and "`document.rendered`
    // committed" produces (bug #8) — before this, the retry made `doc_2`.
    const replayed = this.byKey.get(input.idempotencyKey);
    const docRef =
      input.docRef ??
      replayed?.docRef ??
      `doc_${this.docs.size + 1}`;

    // The same keyed render applied again, with the region still holding what
    // it wrote: nothing to do, and nothing a participant could see changes.
    // Returning the original result (same revision) is what makes the
    // runner's re-emitted `document.rendered` identical to the first. The
    // real adapter re-writes identical bytes here instead — a new revision in
    // Drive's history, and no visible change — so the fake does not record
    // a second render. If the region changed since (a human edit), fall
    // through: that is a new decision for `resolveManagedRegionWrite`.
    if (
      replayed !== undefined &&
      replayed.docRef === docRef &&
      this.docs.get(docRef) === replayed.content
    ) {
      return replayed.result;
    }

    const existing = this.docs.get(docRef) ?? null;
    const currentRegionText = existing === null ? null : readManagedRegion(existing);
    const isEcho = this.revisionAuthor.get(docRef) === "service";

    const { text, pinned } = resolveManagedRegionWrite({
      markdown: input.markdown,
      currentRegionText,
      lastRendered: this.lastRendered.get(docRef) ?? null,
      isEcho,
    });

    // Only the managed region is replaced; anything the pair wrote outside the
    // markers is left alone. When pinned, `text` is the human's own content,
    // so this is a no-op write rather than a clobber — and the revision stays
    // attributed to the human, not us, so the same divergence is detected
    // again on the next render instead of being mistaken for our own echo.
    this.docs.set(docRef, wrapManaged(text));
    if (!pinned) {
      this.lastRendered.set(docRef, text);
      this.revisionAuthor.set(docRef, "service");
    }

    // A set, not a list: the real adapter grants access once and skips anyone
    // who already has it, so a fake that accumulated duplicates on every
    // re-render would let a regression there pass unnoticed here.
    const shared = this.shares.get(docRef) ?? new Set<string>();
    for (const { email } of input.collaborators) {
      if (email.trim().length > 0) shared.add(email);
    }
    this.shares.set(docRef, shared);
    this.revision++;
    this.recorder.record("document.rendered", {
      docRef,
      title: input.title,
      bytes: text.length,
      collaborators: [...shared],
      pinned,
    });
    const result = {
      docRef,
      url: `https://docs.example/${docRef}`,
      revisionId: `rev_${this.revision}`,
      pinned,
    };
    this.byKey.set(input.idempotencyKey, {
      docRef,
      content: this.docs.get(docRef)!,
      result,
    });
    return result;
  }

  read(docRef: string): string | undefined {
    return this.docs.get(docRef);
  }

  /** Emails granted edit access to `docRef`, in the order first granted. */
  sharedWith(docRef: string): string[] {
    return [...(this.shares.get(docRef) ?? [])];
  }

  /**
   * Test hook standing in for a human opening the doc and editing the
   * managed region directly — the exact case pinning exists to protect
   * against. Marks the current revision as human-authored, so the next
   * render detects the divergence from our own last-rendered baseline.
   */
  humanEdit(docRef: string, markdown: string): void {
    this.docs.set(docRef, wrapManaged(markdown));
    this.revisionAuthor.set(docRef, "human");
  }

  /**
   * Test hook standing in for the vendor's own side effects on our write —
   * e.g. Drive reformatting whitespace on save — where the bytes in the
   * region differ from what we rendered, but the revision is still ours.
   * Exercises echo suppression: this must never be mistaken for pinning.
   */
  simulateServiceEcho(docRef: string, driftedMarkdown: string): void {
    this.docs.set(docRef, wrapManaged(driftedMarkdown));
    this.revisionAuthor.set(docRef, "service");
  }
}

/**
 * In-memory stand-in for `GoogleSheetsAdapter` — one spreadsheet
 * (create-or-reuse, keyed by an id it hands back), one tab per report type,
 * full overwrite on every `writeTab`. Tracks writes so a test can assert
 * "tab X now has exactly these rows" without a real Sheets account, the same
 * role `FakeDocument` plays for the document slot.
 */
export class FakeSheet implements SheetAdapter {
  readonly slot = "sheet" as const;
  readonly id = "fake-sheet";
  private nextId = 1;
  private readonly spreadsheets = new Set<string>();
  private readonly tabs = new Map<string, Map<string, { columns: string[]; rows: unknown[][] }>>();

  constructor(readonly recorder: Recorder) {}

  async probe(): Promise<AdapterCapabilities> {
    return caps({});
  }

  async ensureSpreadsheet(input: {
    spreadsheetId: string | null;
    title: string;
    idempotencyKey: string;
  }): Promise<{ spreadsheetId: string; url: string }> {
    if (input.spreadsheetId !== null && this.spreadsheets.has(input.spreadsheetId)) {
      return { spreadsheetId: input.spreadsheetId, url: sheetUrl(input.spreadsheetId) };
    }
    if (input.spreadsheetId !== null) {
      // A configured id this fake has never seen — adopt it rather than
      // silently minting a different one, the same "trust the caller's own
      // record" rule the real adapter follows once a spreadsheet is
      // configured.
      this.spreadsheets.add(input.spreadsheetId);
      return { spreadsheetId: input.spreadsheetId, url: sheetUrl(input.spreadsheetId) };
    }
    const spreadsheetId = `sheet_${this.nextId++}`;
    this.spreadsheets.add(spreadsheetId);
    this.recorder.record("sheet.created", { spreadsheetId, title: input.title });
    return { spreadsheetId, url: sheetUrl(spreadsheetId) };
  }

  async writeTab(input: {
    spreadsheetId: string;
    tabTitle: string;
    columns: string[];
    rows: unknown[][];
    idempotencyKey: string;
  }): Promise<void> {
    const tabs = this.tabs.get(input.spreadsheetId) ?? new Map();
    // A full overwrite, never a merge with the previous rows — same
    // discipline the real adapter's clear-then-write documents.
    tabs.set(input.tabTitle, { columns: input.columns, rows: input.rows });
    this.tabs.set(input.spreadsheetId, tabs);
    this.recorder.record("sheet.tab_written", {
      spreadsheetId: input.spreadsheetId,
      tabTitle: input.tabTitle,
      rows: input.rows.length,
    });
  }

  /** Test hook: what a tab currently holds, or `undefined` if never written. */
  tab(
    spreadsheetId: string,
    tabTitle: string,
  ): { columns: string[]; rows: unknown[][] } | undefined {
    return this.tabs.get(spreadsheetId)?.get(tabTitle);
  }

  /** Test hook: every tab title ever written for a spreadsheet. */
  tabTitles(spreadsheetId: string): string[] {
    return [...(this.tabs.get(spreadsheetId)?.keys() ?? [])];
  }
}

function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.example/spreadsheets/${spreadsheetId}`;
}

export const MANAGED_START = "<!-- mentorship:managed:start -->";
export const MANAGED_END = "<!-- mentorship:managed:end -->";

export function wrapManaged(markdown: string): string {
  return `${MANAGED_START}\n${markdown}\n${MANAGED_END}`;
}

/** The inverse of `wrapManaged` — `null` when the markers are not present. */
export function readManagedRegion(text: string): string | null {
  const start = text.indexOf(MANAGED_START);
  if (start === -1) return null;
  const contentStart = start + MANAGED_START.length;
  const end = text.indexOf(MANAGED_END, contentStart);
  if (end === -1) return null;
  return text.slice(contentStart, end).replace(/^\n/, "").replace(/\n$/, "");
}
