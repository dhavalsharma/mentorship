import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { named, ofKind } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { proseIsNeverAVerdict } from "./journeys/notes.js";

describe("journey: prose-is-never-a-verdict", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(proseIsNeverAVerdict);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("keeps a typed 'confirmed' as a note, verbatim", () => {
    const bodies = named(log, "notes.submitted").map((e) => e.payload["body"]);
    expect(bodies).toContain("Confirmed, looks good to me.");
    expect(bodies).toContain("yes — confirmed ✅");
  });

  it("writes extraction.confirmed only from the buttons, and only after them (invariant 9)", () => {
    const confirmed = named(log, "extraction.confirmed");
    expect(confirmed).toHaveLength(2);
    expect(confirmed.every((e) => typeof e.payload["participantId"] === "string")).toBe(true);
    const lastProse = named(log, "notes.submitted").at(-1)!;
    expect(Date.parse(confirmed[0]!.occurredAt)).toBeGreaterThan(Date.parse(lastProse.occurredAt) + 3_600_000 - 1);
  });

  it("asked for feedback only once the buttons had been pressed", () => {
    const secondVerdict = Date.parse(named(log, "extraction.confirmed")[1]!.occurredAt);
    const feedback = ofKind(s.calls(), "dm.sent").filter((d) =>
      String(d.detail["body"]).startsWith("Was that session useful?"),
    );
    expect(feedback).toHaveLength(2);
    expect(feedback.every((d) => Date.parse(d.at) >= secondVerdict)).toBe(true);
  });

  it("did not extract the typed verdicts as a second session", () => {
    expect(named(log, "extraction.completed")).toHaveLength(1);
  });
});

describeProperties(proseIsNeverAVerdict);
