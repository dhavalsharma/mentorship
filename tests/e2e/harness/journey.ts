import { stage, type Stage, type StageOptions } from "./stage.js";

/**
 * A journey is a stage configuration plus a script of human actions. Keeping
 * the script separate from its assertions is what lets the properties re-run
 * it — twice for determinism, in two orgs at once for isolation, crashed at
 * every adapter call for resume — without re-stating anything.
 *
 * A script may `expect` along the way (it has to read the agreement it is
 * about to click), and those expectations hold on every re-run too.
 */
export interface Journey {
  name: string;
  options?: StageOptions;
  script(stage: Stage): Promise<void>;
}

export function defineJourney(journey: Journey): Journey {
  return journey;
}

export async function runJourney(
  journey: Journey,
  overrides: Partial<StageOptions> = {},
): Promise<Stage> {
  const s = await stage({ ...journey.options, ...overrides });
  try {
    await journey.script(s);
  } catch (error) {
    await s.close();
    throw error;
  }
  return s;
}
