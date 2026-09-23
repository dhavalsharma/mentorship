import { describe, expect, it } from "vitest";
import { defineJourney, runJourney } from "./harness/journey.js";
import { describeProperties, normalizedLog } from "./harness/properties.js";
import { happyPath } from "./journeys/happy-path.js";

/**
 * ADR-0003: an imported pair and a matched pair produce the identical
 * `pair.activated`, and nothing downstream can tell them apart. Held to it
 * here the only way that means anything — the whole happy path, seeded both
 * ways, and the two logs compared line for line. If a code path ever branches
 * on `pairings.origin`, this is where it shows.
 */
export const matchedHappyPath = defineJourney({
  ...happyPath,
  name: "happy-path (seeded by a committed matching round)",
  options: { ...happyPath.options, seedVia: "matching" },
});

describe("journey: import-vs-match", () => {
  it("runs the same session cycle, event for event and call for call", async () => {
    const [imported, matched] = await Promise.all([
      runJourney(happyPath),
      runJourney(matchedHappyPath),
    ]);
    try {
      const [a, b] = [await normalizedLog(imported), await normalizedLog(matched)];
      expect(b.events).toEqual(a.events);
      expect(b.calls).toEqual(a.calls);
    } finally {
      await imported.close();
      await matched.close();
    }
  });
});

describeProperties(matchedHappyPath);
