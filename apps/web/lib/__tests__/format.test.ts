import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  nudgeStateTone,
  requiresHumanLabel,
  severityTone,
} from "../format";

describe("formatTimestamp", () => {
  it("renders a placeholder for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });

  it("renders a placeholder for an unparsable string", () => {
    expect(formatTimestamp("not-a-date")).toBe("—");
  });

  it("renders a real ISO timestamp", () => {
    const rendered = formatTimestamp("2026-01-15T10:00:00.000Z");
    expect(rendered).not.toBe("—");
    expect(rendered.length).toBeGreaterThan(0);
  });
});

describe("severityTone", () => {
  it("maps high/critical to critical", () => {
    expect(severityTone("high")).toBe("critical");
    expect(severityTone("Critical")).toBe("critical");
  });

  it("maps medium/moderate/low to warning", () => {
    expect(severityTone("medium")).toBe("warning");
    expect(severityTone("moderate")).toBe("warning");
    expect(severityTone("low")).toBe("warning");
  });

  it("falls back to neutral for anything unrecognized", () => {
    expect(severityTone("info")).toBe("neutral");
    expect(severityTone("")).toBe("neutral");
  });
});

describe("requiresHumanLabel", () => {
  it("labels true/false", () => {
    expect(requiresHumanLabel(true)).toBe("Needs a human");
    expect(requiresHumanLabel(false)).toBe("Automated");
  });
});

describe("nudgeStateTone", () => {
  it("maps dropped to critical, planned to warning, else neutral", () => {
    expect(nudgeStateTone("dropped")).toBe("critical");
    expect(nudgeStateTone("planned")).toBe("warning");
    expect(nudgeStateTone("sent")).toBe("neutral");
  });
});
