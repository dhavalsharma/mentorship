import { describe, expect, it } from "vitest";
import {
  intersectIntervals,
  nextDueAt,
  proposeSlots,
  subtractIntervals,
  workingWindows,
} from "@mentorship/core";

const FRIDAY = "2026-09-11T06:00:00.000Z";

/** The same calendar day as `slot`, at the given UTC hour. */
function dayAt(slot: { startsAt: string }, hour: number): string {
  const day = slot.startsAt.slice(0, 10);
  const h = String(Math.floor(hour)).padStart(2, "0");
  const m = String(Math.round((hour % 1) * 60)).padStart(2, "0");
  return `${day}T${h}:${m}:00.000Z`;
}

describe("interval maths", () => {
  it("subtracts a busy block from the middle of a window", () => {
    const result = subtractIntervals(
      [{ start: "2026-09-14T09:00:00.000Z", end: "2026-09-14T17:00:00.000Z" }],
      [{ start: "2026-09-14T12:00:00.000Z", end: "2026-09-14T13:00:00.000Z" }],
    );
    expect(result).toEqual([
      { start: "2026-09-14T09:00:00.000Z", end: "2026-09-14T12:00:00.000Z" },
      { start: "2026-09-14T13:00:00.000Z", end: "2026-09-14T17:00:00.000Z" },
    ]);
  });

  it("intersects two availability sets", () => {
    const result = intersectIntervals(
      [{ start: "2026-09-14T09:00:00.000Z", end: "2026-09-14T13:00:00.000Z" }],
      [{ start: "2026-09-14T11:00:00.000Z", end: "2026-09-14T17:00:00.000Z" }],
    );
    expect(result).toEqual([
      { start: "2026-09-14T11:00:00.000Z", end: "2026-09-14T13:00:00.000Z" },
    ]);
  });

  it("excludes weekends from working windows", () => {
    const windows = workingWindows({
      from: FRIDAY,
      days: 4, // Fri 11th through Tue 15th
      tzOffsetMinutes: 0,
      startHour: 9,
      endHour: 17,
    });
    const days = windows.map((w) => w.start.slice(0, 10));
    expect(days).not.toContain("2026-09-12"); // Saturday
    expect(days).not.toContain("2026-09-13"); // Sunday
    expect(days).toContain("2026-09-14"); // Monday
  });
});

describe("proposeSlots", () => {
  const IST = 330;

  it("finds mutual time and avoids both parties' busy blocks", () => {
    const slots = proposeSlots({
      participants: [
        {
          memberRef: "a",
          tzOffsetMinutes: IST,
          busy: [
            {
              start: "2026-09-14T03:30:00.000Z",
              end: "2026-09-14T05:00:00.000Z",
            },
          ],
        },
        { memberRef: "b", tzOffsetMinutes: IST, busy: [] },
      ],
      from: "2026-09-12T06:00:00.000Z",
      horizonDays: 7,
      durationMinutes: 45,
      startHour: 9,
      endHour: 18,
      count: 3,
    });

    expect(slots).toHaveLength(3);
    // 09:00 IST on the Monday is 03:30Z and is blocked, so the first offer
    // is 10:30 IST.
    expect(slots[0]!.startsAt).toBe("2026-09-14T05:00:00.000Z");
    // One slot per day: offering three options on the same afternoon is
    // technically three choices and practically one.
    const days = slots.map((s) => s.startsAt.slice(0, 10));
    expect(new Set(days).size).toBe(3);
  });

  it("offers only times inside both parties' working hours", () => {
    const slots = proposeSlots({
      participants: [
        { memberRef: "ist", tzOffsetMinutes: 330, busy: [] }, // UTC+5:30
        { memberRef: "cet", tzOffsetMinutes: 120, busy: [] }, // UTC+2
      ],
      from: "2026-09-12T06:00:00.000Z",
      horizonDays: 7,
      durationMinutes: 30,
      startHour: 9,
      endHour: 18,
      count: 3,
    });

    // IST 09:00-18:00 is 03:30-12:30Z; CET 09:00-18:00 is 07:00-16:00Z.
    // The only mutual band is 07:00-12:30Z.
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.startsAt >= dayAt(slot, 7)).toBe(true);
      expect(slot.endsAt <= dayAt(slot, 12.5)).toBe(true);
    }
  });

  it("returns nothing rather than a bad slot when there is no overlap", () => {
    // India and California, both keeping 09:00-18:00 locally, have no mutual
    // working hour at all. Saying so is much better than proposing 03:00.
    const slots = proposeSlots({
      participants: [
        { memberRef: "ist", tzOffsetMinutes: 330, busy: [] },
        { memberRef: "pst", tzOffsetMinutes: -420, busy: [] },
      ],
      from: "2026-09-12T06:00:00.000Z",
      horizonDays: 5,
      durationMinutes: 45,
      startHour: 9,
      endHour: 18,
      count: 3,
    });
    expect(slots).toEqual([]);
  });

  it("labels a slot in every participant's own zone", () => {
    const [slot] = proposeSlots({
      participants: [
        { memberRef: "ist", tzOffsetMinutes: 330, busy: [] },
        { memberRef: "cet", tzOffsetMinutes: 120, busy: [] },
      ],
      from: "2026-09-12T06:00:00.000Z",
      horizonDays: 7,
      durationMinutes: 30,
      startHour: 9,
      endHour: 18,
      count: 1,
    });
    expect(slot!.label).toContain("UTC+05:30");
    expect(slot!.label).toContain("UTC+02:00");
  });
});

describe("nextDueAt", () => {
  it("counts from the last session", () => {
    expect(nextDueAt("2026-09-15T00:00:00.000Z", 14, FRIDAY)).toBe(
      "2026-09-29T00:00:00.000Z",
    );
  });

  it("counts from now for a pair that has never met", () => {
    expect(nextDueAt(null, 14, FRIDAY)).toBe("2026-09-25T06:00:00.000Z");
  });

  it("has no due date for an ad-hoc program", () => {
    expect(nextDueAt("2026-09-15T00:00:00.000Z", 0, FRIDAY)).toBeNull();
  });
});
