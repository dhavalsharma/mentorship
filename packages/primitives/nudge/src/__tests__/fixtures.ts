import {
  renderFacts,
  templatesFor,
  ThompsonBandit,
  seededRng,
  type Deficit,
  type NudgeContext,
  type NudgeHistory,
  type NudgePairView,
  type NudgeReader,
  type NudgeRecipient,
  type TemplateStat,
} from "@mentorship/primitive-nudge";
import { NudgeLimitsSchema } from "@mentorship/primitive-nudge";

/** Shared world for the gate and planner tests. Not a test file itself. */

export const NOW = "2026-09-21T14:00:00.000Z"; // a Monday afternoon in UTC

export function recipient(over: Partial<NudgeRecipient> = {}): NudgeRecipient {
  return {
    participantId: "pt_mentee",
    role: "mentee",
    displayName: "Priya",
    memberRef: "U_PRIYA",
    tzOffsetMinutes: 0,
    channels: ["dm", "thread"],
    muted: false,
    snoozedUntil: null,
    quietHours: { startHour: 21, endHour: 8 },
    nudgesLast7Days: 0,
    lastRespondedAt: "2026-09-10T09:00:00.000Z",
    ...over,
  };
}

export const MENTOR: NudgeRecipient = recipient({
  participantId: "pt_mentor",
  role: "mentor",
  displayName: "Sam",
  memberRef: "U_SAM",
  lastRespondedAt: "2026-08-01T09:00:00.000Z", // quieter of the two
});

export function pairView(over: Partial<NudgePairView> = {}): NudgePairView {
  return {
    pairingId: "p_001",
    orgId: "org_1",
    title: "Priya & Sam",
    cadenceLabel: "fortnightly",
    recipients: [recipient(), MENTOR],
    nextScheduledSessionAt: null,
    admin: { participantId: "pt_admin", displayName: "Ada", memberRef: "U_ADA" },
    ...over,
  };
}

export function cadenceDeficit(over: Partial<Deficit> = {}): Deficit {
  return {
    name: "pair.cadence_deficit",
    orgId: "org_1",
    pairingId: "p_001",
    subjectRef: "pairing:p_001",
    occurredAt: NOW,
    dedupeKey: "pairing:p_001:cadence_deficit:2026-W39",
    severity: "medium",
    overdueDays: 7,
    blockedOnParticipantId: null,
    detail: { expectedEveryDays: 14, lastSessionAt: "2026-08-31T12:00:00.000Z" },
    ...over,
  };
}

export function history(over: Partial<NudgeHistory> = {}): NudgeHistory {
  return { delivered: [], consecutiveDrops: 0, sentDedupeKeys: [], ...over };
}

/** A context assembled by hand, for tests that exercise one piece in isolation. */
export function context(over: Partial<NudgeContext> = {}): NudgeContext {
  const deficit = over.deficit ?? cadenceDeficit();
  const pair = over.pair ?? pairView();
  const tone = over.tone ?? "gentle";
  const ctx: NudgeContext = {
    now: NOW,
    deficit,
    pair,
    history: history(),
    subjectLabel: pair.title,
    dedupeKey: deficit.dedupeKey,
    tone,
    ranked: new ThompsonBandit(seededRng(1)).rank(
      templatesFor(deficit.name, tone).map((t) => t.id),
      [],
    ),
    defaultRecipientId: "pt_mentee",
    limits: NudgeLimitsSchema.parse({}),
    sourceText: "",
    ...over,
  };
  ctx.sourceText = renderFacts(ctx);
  return ctx;
}

export interface FakeReaderOptions {
  pair?: NudgePairView;
  history?: NudgeHistory;
  stats?: TemplateStat[];
  subjectLabel?: string;
}

export class FakeNudgeReader implements NudgeReader {
  constructor(private readonly options: FakeReaderOptions = {}) {}

  async pair(): Promise<NudgePairView> {
    return this.options.pair ?? pairView();
  }
  async history(): Promise<NudgeHistory> {
    return this.options.history ?? history();
  }
  async templateStats(): Promise<TemplateStat[]> {
    return this.options.stats ?? [];
  }
  async subjectLabel(): Promise<string> {
    return this.options.subjectLabel ?? "an item";
  }
}
