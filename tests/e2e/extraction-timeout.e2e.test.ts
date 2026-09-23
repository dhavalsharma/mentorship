import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { named, ofKind } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { extractionTimeout } from "./journeys/extraction-timeout.js";

describe("journey: extraction-timeout", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(extractionTimeout);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("auto-confirms, and says so: unverified, with nobody's name on it (invariant 19)", () => {
    const confirmed = named(log, "extraction.confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.payload["unverified"]).toBe(true);
    expect(confirmed[0]!.payload["participantId"]).toBeUndefined();
  });

  it("marks the shared document unverified where a reader will see it", () => {
    const rendered = named(log, "document.rendered");
    expect(rendered).toHaveLength(2);
    const docRef = String(rendered[0]!.payload["docRef"]);
    expect(s.vendor.document!.read(docRef)).toContain(
      "Not reviewed by either participant — treat as unverified.",
    );
  });

  // KNOWN BUG — session-lifecycle.ts, `confirming` timeout: the "unverified"
  // marker is rendered as the *whole* managed region, so it replaces the
  // write-up it is meant to qualify. After an auto-confirm the pair's doc says
  // "treat as unverified" about nothing — the action items are gone. Marking
  // a guess unverified must not erase it (invariant 19 says mark, not drop).
  it.fails("keeps the extracted write-up in the document alongside the unverified marker", () => {
    const [first] = named(log, "document.rendered");
    const doc = s.vendor.document!.read(String(first!.payload["docRef"]))!;
    expect(doc).toContain("## Action items");
    expect(doc).toContain("draft the internal application");
  });

  it("moves on to feedback afterwards", () => {
    expect(
      ofKind(s.calls(), "dm.sent").filter((d) =>
        String(d.detail["body"]).startsWith("Was that session useful?"),
      ),
    ).toHaveLength(2);
  });
});

describeProperties(extractionTimeout);
