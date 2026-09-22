import { describe, expect, it } from "vitest";
import {
  daysSince,
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

describe("daysSince", () => {
  const now = () => new Date("2026-09-22T12:00:00.000Z");

  it("renders a placeholder for an unparsable value", () => {
    expect(daysSince("not-a-date", now)).toBe("—");
  });

  it("renders 'less than a day' for something within the last 24h", () => {
    expect(daysSince("2026-09-22T00:00:00.000Z", now)).toBe("less than a day");
  });

  it("renders '1 day' for exactly one day ago", () => {
    expect(daysSince("2026-09-21T11:00:00.000Z", now)).toBe("1 day");
  });

  it("renders 'N days' for more than a day ago", () => {
    expect(daysSince("2026-09-15T12:00:00.000Z", now)).toBe("7 days");
  });
});
