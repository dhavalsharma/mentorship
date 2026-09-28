import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { named } from "./harness/observe.js";
import { describeProperties } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { documentEcho, documentPinned, HUMAN_EDIT } from "./journeys/document-pinned.js";

describe("journey: document-pinned", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(documentPinned);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("reports the second render as pinned, and leaves the human's words in place (ADR-0005)", () => {
    const rendered = named(log, "document.rendered");
    expect(rendered.map((e) => e.payload["pinned"])).toEqual([false, true]);
    const doc = s.vendor.document!.read(String(rendered[0]!.payload["docRef"]))!;
    expect(doc).toContain(HUMAN_EDIT);
    expect(doc).not.toContain("treat as unverified");
  });

  it("still records the auto-confirm as unverified in the log (invariant 19)", () => {
    expect(named(log, "extraction.confirmed")[0]!.payload["unverified"]).toBe(true);
  });
});

describe("journey: document-echo", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(documentEcho);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("does not mistake an echo of its own write for a human edit", () => {
    const rendered = named(log, "document.rendered");
    expect(rendered.map((e) => e.payload["pinned"])).toEqual([false, false]);
    const doc = s.vendor.document!.read(String(rendered[0]!.payload["docRef"]))!;
    expect(doc).not.toContain("(re-flowed)");
  });
});

describeProperties(documentPinned);
describeProperties(documentEcho);
