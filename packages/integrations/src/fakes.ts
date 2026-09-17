import type {
  AdapterCapabilities,
  CalendarAdapter,
  CalendarEventRef,
  ConversationAdapter,
  DmAdapter,
  DocumentAdapter,
  Interval,
  ProposalOption,
  ThreadRef,
  TranscriptAdapter,
} from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";

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
  }): Promise<{ docRef: string; url: string; revisionId: string }> {
    const docRef = input.docRef ?? `doc_${this.docs.size + 1}`;
    // Only the managed region is replaced; anything the pair wrote outside the
    // markers is left alone.
    this.docs.set(docRef, wrapManaged(input.markdown));
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
      bytes: input.markdown.length,
      collaborators: [...shared],
    });
    return {
      docRef,
      url: `https://docs.example/${docRef}`,
      revisionId: `rev_${this.revision}`,
    };
  }

  read(docRef: string): string | undefined {
    return this.docs.get(docRef);
  }

  /** Emails granted edit access to `docRef`, in the order first granted. */
  sharedWith(docRef: string): string[] {
    return [...(this.shares.get(docRef) ?? [])];
  }
}

export const MANAGED_START = "<!-- mentorship:managed:start -->";
export const MANAGED_END = "<!-- mentorship:managed:end -->";

export function wrapManaged(markdown: string): string {
  return `${MANAGED_START}\n${markdown}\n${MANAGED_END}`;
}
