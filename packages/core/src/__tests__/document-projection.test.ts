import { describe, expect, it } from "vitest";
import {
  renderWriteUp,
  resolveManagedRegionWrite,
  UNVERIFIED_BANNER,
} from "@mentorship/core";

/**
 * The projection's text shape, pinned exactly. Invariant 19: a confirmation
 * timeout *marks* the write-up unverified — journey-suite bug #3 was the
 * banner replacing it.
 */

const WRITE_UP = [
  "## Session summary",
  "",
  "## Action items",
  "- Priya: draft the internal application",
].join("\n");

describe("renderWriteUp", () => {
  it("renders a pending write-up byte-identically to the extraction's markdown", () => {
    expect(renderWriteUp({ markdown: WRITE_UP, unverified: false })).toBe(WRITE_UP);
  });

  it("puts the unverified banner above the full write-up, never in place of it", () => {
    expect(renderWriteUp({ markdown: WRITE_UP, unverified: true })).toBe(
      [
        "> Not reviewed by either participant — treat as unverified.",
        "",
        "## Session summary",
        "",
        "## Action items",
        "- Priya: draft the internal application",
      ].join("\n"),
    );
  });

  it("does not stack a second banner on an already-marked write-up", () => {
    const once = renderWriteUp({ markdown: WRITE_UP, unverified: true });
    expect(renderWriteUp({ markdown: once, unverified: true })).toBe(once);
    expect(once.split(UNVERIFIED_BANNER)).toHaveLength(2);
  });
});

describe("the unverified re-render through resolveManagedRegionWrite", () => {
  const pending = renderWriteUp({ markdown: WRITE_UP, unverified: false });
  const unverified = renderWriteUp({ markdown: WRITE_UP, unverified: true });

  it("replaces an untouched region with banner + write-up", () => {
    expect(
      resolveManagedRegionWrite({
        markdown: unverified,
        currentRegionText: pending,
        lastRendered: pending,
        isEcho: false,
      }),
    ).toEqual({ text: unverified, pinned: false });
  });

  it("never overwrites a human edit — the edit is pinned, banner or not", () => {
    const edited = `${pending}\n\nArjun: we also agreed to swap reading lists.`;
    expect(
      resolveManagedRegionWrite({
        markdown: unverified,
        currentRegionText: edited,
        lastRendered: pending,
        isEcho: false,
      }),
    ).toEqual({ text: edited, pinned: true });
  });

  it("treats our own echo as ours, and marks it", () => {
    expect(
      resolveManagedRegionWrite({
        markdown: unverified,
        currentRegionText: `${pending}\n`,
        lastRendered: pending,
        isEcho: true,
      }),
    ).toEqual({ text: unverified, pinned: false });
  });
});
