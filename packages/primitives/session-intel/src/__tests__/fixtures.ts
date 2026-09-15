import { defaultPolicy, type PairContext, type ProgramPolicy } from "@mentorship/core";
import type { SessionIntelContext } from "@mentorship/primitive-session-intel";

/** One pair, two consenting participants, used by every test in this package. */
export function pairFixture(
  over: { aiProcessing?: boolean; policy?: ProgramPolicy } = {},
): PairContext {
  const aiProcessing = over.aiProcessing ?? true;
  return {
    pairingId: "pair_1",
    orgId: "org_1",
    title: "Priya & Sam",
    state: "active",
    origin: "imported",
    policy: over.policy ?? defaultPolicy({}),
    cadence: (over.policy ?? defaultPolicy({})).cadence,
    participants: [
      {
        participantId: "part_mentor",
        role: "mentor",
        displayName: "Sam Okafor",
        email: "sam@example.com",
        memberRef: "U_SAM",
        calendarRef: "sam@example.com",
        tzOffsetMinutes: 0,
        consent: { aiProcessing, recording: false },
      },
      {
        participantId: "part_mentee",
        role: "mentee",
        displayName: "Priya Nair",
        email: "priya@example.com",
        memberRef: "U_PRIYA",
        calendarRef: "priya@example.com",
        tzOffsetMinutes: 330,
        consent: { aiProcessing, recording: false },
      },
    ],
    lastSessionAt: null,
    documentRef: null,
  };
}

export const TRANSCRIPT = [
  "Priya Nair: The promotion packet is still the main thing on my mind.",
  "Sam Okafor: I'll review your draft packet by Friday and send comments.",
  "Priya Nair: Thanks — that would be really helpful.",
  "Priya Nair: I'm blocked on getting the metrics from the data team.",
  "Priya Nair: I will write it up before we next meet.",
].join("\n");

/** Builds a context directly, for the parts that do not need a reader. */
export function contextFixture(
  over: Partial<SessionIntelContext> = {},
): SessionIntelContext {
  const pair = pairFixture();
  return {
    sessionId: "sess_1",
    pairingId: pair.pairingId,
    orgId: pair.orgId,
    title: pair.title,
    sourceRef: "transcript:fake:1",
    sourceKind: "transcript",
    source: TRANSCRIPT,
    participants: pair.participants.map((p) => ({
      participantId: p.participantId,
      role: p.role,
      displayName: p.displayName,
      aiProcessing: p.consent.aiProcessing,
    })),
    goals: [{ goalRef: "goal_1", title: "promotion packet" }],
    inferenceAllowed: true,
    ...over,
  };
}

/** Locates `quote` in `source` and builds the span a truthful model would return. */
export function spanOf(source: string, quote: string) {
  const start = source.indexOf(quote);
  if (start === -1) throw new Error(`fixture quote not in source: ${quote}`);
  return { start, end: start + quote.length, quote };
}
