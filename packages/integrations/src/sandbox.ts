import type {
  Adapter,
  CalendarAdapter,
  CalendarEventRef,
  ConversationAdapter,
  DmAdapter,
  Interval,
  ThreadRef,
} from "@mentorship/core";

/**
 * A hard stop between a live-tenant test and a real colleague.
 *
 * Pointing the Slack and Google adapters at a real workspace is the only way
 * to learn whether they work, and it is also the first time this code can
 * reach someone who did not sign up for it. The failure does not need a bug in
 * the adapters: one real email in a `pairings` row is enough, and
 * `sendUpdates: "all"` means Google mails the invitation before anyone notices.
 *
 * So recipients are checked against an allowlist at the boundary, and anything
 * else throws. Throwing rather than skipping is deliberate — a silent no-op
 * during a live test looks exactly like a broken adapter, and the point of the
 * exercise is to find out which of the two you have.
 *
 * Every wrapper is `async` on purpose: a synchronous throw from a method the
 * effect runner awaits arrives somewhere quite different from a rejected
 * promise, and the difference only shows up under load.
 *
 * This is a seatbelt, not a substitute for isolation. A separate Slack
 * workspace and a dedicated calendar are still the first line; this is what
 * catches the case where the isolation was not as complete as it looked.
 */

export interface SandboxOptions {
  /** Emails and chat member ids that may be contacted. Compared case-insensitively. */
  allowlist: string[];
  /** Called before throwing, so a test run can show what it stopped. */
  onRefused?: (detail: { adapter: string; refused: string[] }) => void;
}

export class SandboxRefusal extends Error {
  constructor(
    readonly adapter: string,
    readonly refused: string[],
  ) {
    super(
      `sandbox refused ${adapter}: ${refused.join(", ")} not in the allowlist`,
    );
    this.name = "SandboxRefusal";
  }
}

export class SandboxGuard {
  private readonly allowed: Set<string>;

  constructor(private readonly options: SandboxOptions) {
    this.allowed = new Set(
      options.allowlist.map((entry) => entry.trim().toLowerCase()),
    );
    if (this.allowed.size === 0) {
      // An empty allowlist that quietly permits everything would be the worst
      // possible reading of "guard".
      throw new Error("sandbox allowlist is empty — refusing to allow anything");
    }
  }

  check(adapter: string, refs: (string | undefined | null)[]): void {
    const refused = refs
      .filter((r): r is string => typeof r === "string" && r.length > 0)
      .filter((r) => !this.allowed.has(normalise(r)));
    if (refused.length === 0) return;
    this.options.onRefused?.({ adapter, refused });
    throw new SandboxRefusal(adapter, refused);
  }
}

/** An email marker (`email:someone@x`) is still that someone. */
function normalise(ref: string): string {
  const trimmed = ref.trim().toLowerCase();
  return trimmed.startsWith("email:") ? trimmed.slice("email:".length) : trimmed;
}

export function guardConversation(
  inner: ConversationAdapter,
  guard: SandboxGuard,
): ConversationAdapter {
  return {
    slot: "conversation",
    id: inner.id,
    probe: () => inner.probe(),
    async ensureThread(input): Promise<ThreadRef> {
      guard.check(`${inner.id}.ensureThread`, input.memberRefs);
      return inner.ensureThread(input);
    },
    // Posting into a thread that `ensureThread` already vetted needs no second
    // check — the thread is the allowlisted set of people.
    postProposal: (input) => inner.postProposal(input),
    postConfirmation: (input) => inner.postConfirmation(input),
    postMessage: (input) => inner.postMessage(input),
  };
}

export function guardDm(inner: DmAdapter, guard: SandboxGuard): DmAdapter {
  return {
    slot: "dm",
    id: inner.id,
    probe: () => inner.probe(),
    async send(input) {
      guard.check(`${inner.id}.send`, [input.memberRef]);
      return inner.send(input);
    },
  };
}

export function guardCalendar(
  inner: CalendarAdapter,
  guard: SandboxGuard,
): CalendarAdapter {
  return {
    slot: "calendar",
    id: inner.id,
    probe: () => inner.probe(),
    async freeBusy(input): Promise<Record<string, Interval[]>> {
      // Reading someone's free/busy is not as loud as mailing them, but it is
      // still their data.
      guard.check(`${inner.id}.freeBusy`, input.memberRefs);
      return inner.freeBusy(input);
    },
    async createEvent(input): Promise<CalendarEventRef> {
      // The one that sends mail.
      guard.check(`${inner.id}.createEvent`, input.memberRefs);
      return inner.createEvent(input);
    },
    getEvent: (eventId) => inner.getEvent(eventId),
  };
}

/** Wraps whichever of the three human-facing slots an adapter fills. */
export function guardAdapter<T extends Adapter>(
  adapter: T,
  guard: SandboxGuard,
): Adapter {
  switch (adapter.slot) {
    case "conversation":
      return guardConversation(adapter as unknown as ConversationAdapter, guard);
    case "dm":
      return guardDm(adapter as unknown as DmAdapter, guard);
    case "calendar":
      return guardCalendar(adapter as unknown as CalendarAdapter, guard);
    default:
      // transcript, document, sheet, dashboard and conferencing do not address
      // a person directly; they act on artefacts the pair already owns.
      return adapter;
  }
}
