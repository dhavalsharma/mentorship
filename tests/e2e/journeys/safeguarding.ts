import { DeterministicProvider } from "@mentorship/ai";
import { defineJourney } from "../harness/journey.js";
import { CLEAN_EXTRACTION } from "../harness/properties.js";
import { say } from "../harness/observe.js";
import type { Stage } from "../harness/stage.js";
import { reachHeld } from "./steps.js";

/**
 * Safeguarding detection is a model call (invariants 8 and 16): the heuristic
 * stub and the primitive's fallback never raise it. So these journeys run the
 * real session-intel primitive through `createWorker({ llm })`, with a
 * deterministic provider standing in for the model's verdict. Both parties
 * consented to AI processing, or the primitive would never ask.
 */
export const DISCLOSURE =
  "Priya: Something happened with my manager that I need to tell someone about.";

const flagging = () =>
  new DeterministicProvider({
    fallbackValue: {
      ...CLEAN_EXTRACTION,
      summary: ["A disclosure was made that needs a named human."],
      riskFlags: ["safeguarding"],
    },
  });

const script = async (s: Stage): Promise<void> => {
  await reachHeld(s);
  await say(s, s.mentee, DISCLOSURE);
  await s.drain();
  // The program's cadence keeps moving: the next session is still proposed.
  s.advanceBy({ days: 10 });
  await s.drain();
};

export const SAFEGUARDING_CONTACT = "U-SAFEGUARD";

export const safeguarding = defineJourney({
  name: "safeguarding",
  options: {
    llm: flagging(),
    consents: { aiProcessing: true },
    policy: { safeguarding: { contactMemberRef: SAFEGUARDING_CONTACT } },
  },
  script,
});

export const safeguardingUnconfigured = defineJourney({
  name: "safeguarding-unconfigured",
  options: {
    llm: flagging(),
    consents: { aiProcessing: true },
  },
  script,
});
