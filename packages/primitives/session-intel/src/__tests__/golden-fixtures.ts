import type { GoldenCase } from "@mentorship/primitive-session-intel";

/**
 * Hand-labelled golden cases for the fallback (cue-phrase) extraction path.
 *
 * DATA ONLY — deliberately not `*.test.ts` so vitest does not collect it as a
 * test file; `golden.test.ts` imports it and does the asserting.
 *
 * Every `expectedActionItems` entry below was written by reading the
 * transcript as a careful human would, *before* running `fallbackExtraction`
 * against it — not by reverse-engineering the fixture from the fallback's own
 * output. That is the entire point of a golden set: it has to be honest about
 * where the deterministic path is weak (see the last case), not just record
 * whatever the code already does.
 *
 * Owners use the participant ids from `fixtures.ts`'s default pair
 * (`pairFixture` / `contextFixture`): `part_mentor` is Sam Okafor,
 * `part_mentee` is Priya Nair.
 */

const PART_MENTOR = "part_mentor";
const PART_MENTEE = "part_mentee";

export const GOLDEN_CASES: GoldenCase[] = [
  {
    // A clear, explicit commitment with a due date — the case the cue-phrase
    // list was built for. Should be found cleanly.
    name: "clear commitment with a due date",
    source: [
      "Sam Okafor: How's the promotion packet coming along?",
      "Priya Nair: Slowly, but moving in the right direction.",
      "Sam Okafor: I'll send you my written feedback on the draft by Friday.",
    ].join("\n"),
    expectedActionItems: [
      { owner: PART_MENTOR, textContains: "written feedback" },
    ],
  },
  {
    // A blocker, phrased plainly, with no accompanying commitment. A human
    // reader would log the blocker and extract zero action items — nobody
    // committed to anything here, they just agreed to think about it.
    name: "blocker with no accompanying commitment",
    source: [
      "Priya Nair: I wanted to flag something before we go further.",
      "Priya Nair: I'm stuck waiting on approval from my manager to even start the budget analysis.",
      "Sam Okafor: Got it, thanks for the heads up. Let's think about who else could unblock that.",
    ].join("\n"),
    expectedActionItems: [],
  },
  {
    // A goal gets mentioned and re-affirmed, but nobody commits to a new
    // action around it. Only action items are scored by this harness, so the
    // expectation here is an empty list — the goal-progress side of this
    // exchange is out of scope for `scoreActionItems`.
    name: "goal mention with no new commitment",
    source: [
      "Priya Nair: The promotion packet is still the main thing on my mind this cycle.",
      "Sam Okafor: Makes sense, it's the goal we set out back in January.",
      "Priya Nair: Exactly, I want to keep it front and center.",
    ].join("\n"),
    expectedActionItems: [],
  },
  {
    // No extractable commitments at all — pure catching-up, nothing anyone
    // owes anyone. A valid, important case: the fallback should correctly
    // find nothing rather than manufacturing a false positive.
    name: "no extractable commitments at all",
    source: [
      "Priya Nair: Good to see you, how was your week?",
      "Sam Okafor: Pretty quiet, mostly catching up on emails.",
      "Priya Nair: Same here, nothing major to report.",
    ].join("\n"),
    expectedActionItems: [],
  },
  {
    // Both participants commit to something in the same exchange. Tests that
    // ownership is attributed correctly to each speaker rather than both
    // landing on one person or on `unassigned`.
    name: "multi-speaker exchange with commitments from both sides",
    source: [
      "Sam Okafor: I'll review your slide deck tonight and leave comments.",
      "Priya Nair: Great, and I will send over the latest metrics by Monday so you have context.",
      "Sam Okafor: Perfect, that works.",
    ].join("\n"),
    expectedActionItems: [
      { owner: PART_MENTOR, textContains: "review your slide deck" },
      { owner: PART_MENTEE, textContains: "latest metrics" },
    ],
  },
  {
    // A deliberately tricky case: a real commitment, phrased in a way none of
    // `fallback.ts`'s COMMITMENT_CUES catch ("I plan to..." rather than
    // "I'll"/"I will", no "by <day>" due phrase, no "send me"/"let's make"/
    // "write it up"). A careful human reader would log this as an action
    // item for Priya. This case is expected to fail against the fallback —
    // that failure is the honest, documented limit of a regex-only path, not
    // a bug in the golden set.
    name: "commitment phrased in a way the cue-phrase regexes miss",
    source: [
      "Priya Nair: I plan to have the proposal ready before we next meet, no matter what.",
      "Sam Okafor: Sounds good, that's an important one.",
    ].join("\n"),
    expectedActionItems: [
      { owner: PART_MENTEE, textContains: "proposal ready" },
    ],
  },
];
