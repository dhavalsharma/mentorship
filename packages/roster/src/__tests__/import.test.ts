import { describe, expect, it, vi } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import {
  commitRosterImport,
  emptyExistingState,
  pairKey,
  parseCadence,
  parseDelimited,
  parseSessionMinutes,
  parseTzOffset,
  planIsCommittable,
  planRosterImport,
  type RosterSink,
} from "@mentorship/roster";

const POLICY = defaultPolicy({
  pairing: { mode: "imported", mentorCapacityDefault: 2 },
});

const HEADER =
  "Mentor Email,Mentor Name,Mentee Email,Mentee Name,Cadence,Mentor Slack,Mentee Slack,Mentor TZ,Mentee TZ";

const row = (
  mentor: string,
  mentee: string,
  cadence = "fortnightly",
  extra = "U-M,U-E,+05:30,+05:30",
) => `${mentor},Mentor Name,${mentee},Mentee Name,${cadence},${extra}`;

const plan = (csv: string, existing = emptyExistingState()) =>
  planRosterImport(csv, { policy: POLICY, existing, defaultTzOffsetMinutes: 330 });

describe("delimited parsing", () => {
  it("handles quoted fields, embedded delimiters and escaped quotes", () => {
    const rows = parseDelimited(
      'a,b,c\r\n"one, two","he said ""hi""",three\n',
    );
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["one, two", 'he said "hi"', "three"],
    ]);
  });

  it("sniffs tab-separated files", () => {
    expect(parseDelimited("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM, which is how most exported sheets arrive", () => {
    expect(parseDelimited("﻿mentor_email,mentee_email\n")).toEqual([
      ["mentor_email", "mentee_email"],
    ]);
  });
});

describe("column aliases", () => {
  it("accepts whatever the admin called the columns", () => {
    const result = plan(
      "Mentor E-Mail,Mentee e mail,Meeting Frequency\na@x.com,b@x.com,monthly",
    );
    expect(result.errors).toEqual([]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]!.cadenceOverride).toMatchObject({ everyDays: 30 });
  });

  it("reports columns it ignored rather than silently dropping them", () => {
    const result = plan(
      "mentor_email,mentee_email,Cost Centre\na@x.com,b@x.com,CC-42",
    );
    expect(result.unknownColumns).toEqual(["Cost Centre"]);
  });

  it("fails loudly when there is no mentee column at all", () => {
    const result = plan("mentor_email,cadence\na@x.com,monthly");
    expect(result.errors[0]!.message).toMatch(/no column found for menteeEmail/);
    expect(planIsCommittable(result)).toBe(false);
  });
});

describe("row validation", () => {
  it("rejects a row that pairs someone with themselves", () => {
    const result = plan(`${HEADER}\n${row("a@x.com", "a@x.com")}`);
    expect(result.errors[0]!.message).toMatch(/same person/);
    expect(result.creates).toEqual([]);
  });

  it("rejects an unreadable email and keeps the good rows", () => {
    const result = plan(
      `${HEADER}\n${row("a@x.com", "nope")}\n${row("c@x.com", "d@x.com")}`,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.creates).toHaveLength(1);
  });

  it("rejects a cadence it cannot interpret, naming the options", () => {
    const result = plan(
      `${HEADER}\n${row("a@x.com", "b@x.com", "when the moon is full")}`,
    );
    expect(result.errors[0]!.message).toMatch(/unrecognised cadence/);
    expect(result.errors[0]!.message).toMatch(/fortnightly/);
  });

  it("reads a rhythm in weeks, labelled the way pair preferences label it", () => {
    expect(parseCadence("every 3 weeks")).toEqual({
      cadence: { everyDays: 21, label: "three-weekly" },
      ok: true,
    });
    expect(parseCadence("4 weeks").cadence).toEqual({
      everyDays: 28,
      label: "four-weekly",
    });
  });

  it("reads a session-length column into the pair's cadence override", () => {
    const result = planRosterImport(
      "mentor_email,mentee_email,cadence,duration\na@x.com,b@x.com,weekly,30 min",
      { policy: POLICY, existing: emptyExistingState(), defaultTzOffsetMinutes: 330 },
    );
    expect(result.errors).toEqual([]);
    expect(result.creates[0]!.cadenceOverride).toEqual({
      everyDays: 7,
      label: "weekly",
      sessionMinutes: 30,
    });
  });

  it("keeps the program's rhythm when only a length is given", () => {
    const result = planRosterImport(
      "mentor_email,mentee_email,session_length\na@x.com,b@x.com,1h",
      { policy: POLICY, existing: emptyExistingState(), defaultTzOffsetMinutes: 330 },
    );
    expect(result.creates[0]!.cadenceOverride).toEqual({ sessionMinutes: 60 });
  });

  it("rejects a session length outside 15–240 minutes, naming the field", () => {
    const result = planRosterImport(
      "mentor_email,mentee_email,duration\na@x.com,b@x.com,5",
      { policy: POLICY, existing: emptyExistingState(), defaultTzOffsetMinutes: 330 },
    );
    expect(result.errors[0]!.field).toBe("sessionMinutes");
    expect(result.creates).toHaveLength(0);
  });

  it("parses the common ways a spreadsheet writes a length", () => {
    expect(parseSessionMinutes("45")).toEqual({ sessionMinutes: 45, ok: true });
    expect(parseSessionMinutes("45m").sessionMinutes).toBe(45);
    expect(parseSessionMinutes("30 mins").sessionMinutes).toBe(30);
    expect(parseSessionMinutes("15 minutes").sessionMinutes).toBe(15);
    expect(parseSessionMinutes("2 hours").sessionMinutes).toBe(120);
    expect(parseSessionMinutes(undefined)).toEqual({ sessionMinutes: null, ok: true });
    expect(parseSessionMinutes("half an hour").ok).toBe(false);
    expect(parseSessionMinutes("300").ok).toBe(false);
  });

  it("rejects an unreadable start date", () => {
    const result = plan(
      "mentor_email,mentee_email,start_date\na@x.com,b@x.com,soon-ish",
    );
    expect(result.errors[0]!.field).toBe("startDate");
  });
});

describe("deduplication", () => {
  it("skips a row duplicated inside the same file", () => {
    const result = plan(
      `${HEADER}\n${row("a@x.com", "b@x.com")}\n${row("a@x.com", "b@x.com")}`,
    );
    expect(result.creates).toHaveLength(1);
    expect(result.skipped[0]!.message).toMatch(/duplicate of row 2/);
  });

  it("treats a pair as the same pair with the columns swapped", () => {
    expect(pairKey("a@x.com", "b@x.com")).toBe(pairKey("B@X.com ", "a@x.com"));
  });

  it("skips pairs that already exist, so re-uploading is safe", () => {
    const existing = emptyExistingState();
    existing.pairKeys.add(pairKey("a@x.com", "b@x.com"));
    const result = plan(
      `${HEADER}\n${row("a@x.com", "b@x.com")}\n${row("a@x.com", "c@x.com")}`,
      existing,
    );
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]!.mentee.email).toBe("c@x.com");
    expect(result.skipped).toHaveLength(1);
  });
});

describe("warnings — importable, but look at these", () => {
  it("flags a mentor going over capacity, counting rows in the same upload", () => {
    const result = plan(
      [
        HEADER,
        row("m@x.com", "a@x.com"),
        row("m@x.com", "b@x.com"),
        row("m@x.com", "c@x.com"),
      ].join("\n"),
    );
    expect(result.creates).toHaveLength(3);
    const capacity = result.warnings.filter((w) => /mentees/.test(w.message));
    expect(capacity).toHaveLength(1);
    expect(capacity[0]!.rowNumber).toBe(4);
  });

  it("flags a missing verified chat id rather than guessing from email", () => {
    const result = plan(
      `${HEADER}\n${row("a@x.com", "b@x.com", "monthly", ",,+05:30,+05:30")}`,
    );
    expect(
      result.warnings.some((w) => /verified chat id/.test(w.message)),
    ).toBe(true);
    expect(result.creates).toHaveLength(1);
  });

  it("falls back to the org timezone and says so", () => {
    const result = plan(
      `${HEADER}\n${row("a@x.com", "b@x.com", "monthly", "U-M,U-E,,")}`,
    );
    expect(result.creates[0]!.mentor.tzOffsetMinutes).toBe(330);
    expect(result.warnings.some((w) => /timezone/.test(w.message))).toBe(true);
  });
});

describe("parsers", () => {
  it("reads timezone offsets in the shapes people actually type", () => {
    expect(parseTzOffset("+05:30", 0).minutes).toBe(330);
    expect(parseTzOffset("-0800", 0).minutes).toBe(-480);
    expect(parseTzOffset("5.5", 0).minutes).toBe(330);
    expect(parseTzOffset("330", 0).minutes).toBe(330);
    expect(parseTzOffset("Asia/Calcutta", 60)).toEqual({
      minutes: 60,
      ok: false,
    });
  });

  it("reads cadence aliases and bare day counts", () => {
    expect(parseCadence("biweekly").cadence).toMatchObject({ everyDays: 14 });
    expect(parseCadence("Every Month").cadence).toMatchObject({ everyDays: 30 });
    expect(parseCadence("21d").cadence).toMatchObject({ everyDays: 21 });
    expect(parseCadence("as needed").cadence).toMatchObject({ everyDays: 0 });
    expect(parseCadence(undefined).cadence).toBeNull();
    expect(parseCadence("whenever").ok).toBe(false);
  });
});

describe("commit", () => {
  function sink() {
    let people = 0;
    let pairs = 0;
    const announced: string[] = [];
    const impl: RosterSink = {
      upsertPerson: vi.fn(async () => ({
        participantId: `prt_${++people}`,
      })),
      createPairing: vi.fn(async () => ({ pairingId: `pai_${++pairs}` })),
      announce: vi.fn(async ({ pairingId }) => {
        announced.push(pairingId);
      }),
    };
    return { impl, announced };
  }

  it("refuses to commit a plan with errors unless partial is allowed", async () => {
    const result = plan(`${HEADER}\n${row("a@x.com", "a@x.com")}`);
    const { impl } = sink();
    await expect(
      commitRosterImport(result, impl, { importedPairsStart: "active" }),
    ).rejects.toThrow(/not committable/);
  });

  it("commits the good rows when the admin waives the bad ones", async () => {
    const result = plan(
      `${HEADER}\n${row("a@x.com", "a@x.com")}\n${row("c@x.com", "d@x.com")}`,
    );
    const { impl, announced } = sink();
    const outcome = await commitRosterImport(result, impl, {
      importedPairsStart: "active",
      allowPartial: true,
    });
    expect(outcome.created).toHaveLength(1);
    expect(outcome.partial).toBe(true);
    expect(announced).toHaveLength(1);
  });

  it("marks imported pairs with origin='imported' and their agreed cadence", async () => {
    const result = plan(`${HEADER}\n${row("a@x.com", "b@x.com", "monthly")}`);
    const { impl } = sink();
    await commitRosterImport(result, impl, { importedPairsStart: "active" });
    expect(impl.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "imported",
        state: "active",
        cadenceOverride: expect.objectContaining({ everyDays: 30 }),
      }),
    );
  });

  it("creates each person once even when they appear in several pairs", async () => {
    const result = plan(
      [HEADER, row("m@x.com", "a@x.com"), row("m@x.com", "b@x.com")].join("\n"),
    );
    const { impl } = sink();
    await commitRosterImport(result, impl, { importedPairsStart: "active" });
    // 1 mentor + 2 mentees, not 4.
    expect(impl.upsertPerson).toHaveBeenCalledTimes(3);
  });

  it("hashes the file so a re-upload is recognisable", () => {
    const a = plan(`${HEADER}\n${row("a@x.com", "b@x.com")}`);
    const b = plan(`${HEADER}\n${row("a@x.com", "b@x.com")}`);
    const c = plan(`${HEADER}\n${row("a@x.com", "c@x.com")}`);
    expect(a.fileHash).toBe(b.fileHash);
    expect(a.fileHash).not.toBe(c.fileHash);
  });
});
