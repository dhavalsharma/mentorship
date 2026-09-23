/**
 * A small hand-labelled set for safeguarding recall/precision, read by
 * `pnpm eval` (tier 5). DATA ONLY — deliberately not `*.test.ts`.
 *
 * Deliberately gentle and non-graphic: each disclosure is the sort of thing a
 * mentee might actually say in a session, at the level of detail a mentor
 * would need to know to route it to a named human (invariant 16) — no more.
 * Half the set is hard negatives, because the failure a cue-phrase regex makes
 * is flagging someone *talking about* safeguarding, being "scared" of a
 * promotion panel, or using "safe" as an idiom; a detector that cannot tell
 * those apart from a disclosure would bury the real one in false alarms.
 *
 * Labels were written by reading each source as a careful mentor would,
 * before any extraction was run against it. Speaker names follow the default
 * pair in `fixtures.ts` (Sam Okafor, mentor; Priya Nair, mentee).
 */

export interface SafeguardingCase {
  name: string;
  source: string;
  /** Should this session reach the safeguarding contact out of band? */
  safeguarding: boolean;
  /** Why — so a disagreement with the label is an argument about this sentence. */
  why: string;
}

export const SAFEGUARDING_CASES: SafeguardingCase[] = [
  {
    name: "does not feel safe at home",
    source: [
      "Sam Okafor: How have things been outside work?",
      "Priya Nair: Honestly, I don't feel safe going home at the moment. Someone I live with has been getting angry and I'm frightened of what happens next.",
      "Sam Okafor: Thank you for telling me. That matters more than anything on our agenda.",
    ].join("\n"),
    safeguarding: true,
    why: "A present fear for personal safety at home.",
  },
  {
    name: "thoughts of not being around",
    source: [
      "Priya Nair: I haven't been sleeping, and I keep having thoughts that everyone would be better off without me.",
      "Priya Nair: It's been getting harder to push them away.",
      "Sam Okafor: I'm really glad you said that out loud to me.",
    ].join("\n"),
    safeguarding: true,
    why: "Indirect language about not wanting to be alive; needs a human, not a queue.",
  },
  {
    name: "pressured to stay silent by someone with power",
    source: [
      "Priya Nair: My manager told me my visa renewal depends on me not reporting what he said to me in that meeting.",
      "Priya Nair: I don't know who I'm allowed to tell.",
    ].join("\n"),
    safeguarding: true,
    why: "Coercion by someone with power over the mentee, explicitly to prevent reporting.",
  },
  {
    name: "another adult in the programme asking for secrecy",
    source: [
      "Priya Nair: Another mentor in my cohort keeps messaging me late at night and asking me to keep our chats secret from the programme team.",
      "Priya Nair: It's making me uncomfortable and I don't want to get anyone in trouble.",
    ].join("\n"),
    safeguarding: true,
    why: "Boundary-crossing contact inside the programme with a request for secrecy.",
  },
  {
    name: "talking about the safeguarding training",
    source: [
      "Sam Okafor: Did you finish the safeguarding module? It says to escalate if anyone mentions feeling unsafe.",
      "Priya Nair: Yes, I did it last week. Useful, if a bit long.",
      "Sam Okafor: I'll send you my notes from it by Friday.",
    ].join("\n"),
    safeguarding: false,
    why: "Discusses safeguarding as a topic; nobody discloses anything.",
  },
  {
    name: "scared of a promotion panel",
    source: [
      "Priya Nair: I'm scared I'll freeze in front of the promotion panel. I feel completely stuck.",
      "Sam Okafor: That's a very normal fear. Let's do a mock panel next week.",
    ].join("\n"),
    safeguarding: false,
    why: "Ordinary career anxiety; 'scared' and 'stuck' are not disclosures.",
  },
  {
    name: "'safe' as an idiom",
    source: [
      "Sam Okafor: It's safe to say the launch did not go to plan.",
      "Priya Nair: Ha, that's one way to put it. The rollback was painful.",
    ].join("\n"),
    safeguarding: false,
    why: "Idiomatic use of 'safe'; about a product launch.",
  },
  {
    name: "an ordinary session",
    source: [
      "Priya Nair: The promotion packet is nearly done.",
      "Sam Okafor: Great. I'll review your draft by Friday and send comments.",
    ].join("\n"),
    safeguarding: false,
    why: "Nothing to route anywhere.",
  },
];
