import { describe, expect, it } from "vitest";
import {
  applyPairPreferences,
  cadenceLabelFor,
  defaultPolicy,
  describeCadence,
  PairPreferencesPolicySchema,
  resolveCadence,
  resolvePairPreferences,
  type PairPreferencesSubmission,
} from "@mentorship/core";

const POLICY = defaultPolicy().pairPreferences;

const submit = (
  over: Partial<PairPreferencesSubmission> = {},
): PairPreferencesSubmission => ({
  sessionChoice: null,
  sessionCustom: null,
  cadenceChoice: null,
  cadenceCustom: null,
  ...over,
});

describe("the default menu", () => {
  it("offers 15/30/45 minutes and every 1–4 weeks, each with a custom option", () => {
    expect(POLICY).toEqual({
      enabled: true,
      sessionMinuteChoices: [15, 30, 45],
      cadenceDayChoices: [7, 14, 21, 28],
      allowCustomSessionMinutes: true,
      allowCustomCadenceDays: true,
    });
  });
});

describe("resolvePairPreferences", () => {
  it("accepts a length and a rhythm off the menu", () => {
    expect(
      resolvePairPreferences(
        submit({ sessionChoice: "30", cadenceChoice: "21" }),
        POLICY,
      ),
    ).toEqual({ ok: true, preferences: { sessionMinutes: 30, everyDays: 21 } });
  });

  it("accepts custom values inside the cadence schema's own bounds", () => {
    expect(
      resolvePairPreferences(
        submit({
          sessionChoice: "custom",
          sessionCustom: "60",
          cadenceChoice: "custom",
          cadenceCustom: "10",
        }),
        POLICY,
      ),
    ).toEqual({ ok: true, preferences: { sessionMinutes: 60, everyDays: 10 } });
  });

  it("lets a pair change only one half", () => {
    expect(resolvePairPreferences(submit({ cadenceChoice: "7" }), POLICY)).toEqual({
      ok: true,
      preferences: { everyDays: 7 },
    });
  });

  it("refuses a value that is not on this program's menu, even if it is a valid length", () => {
    const result = resolvePairPreferences(submit({ sessionChoice: "90" }), POLICY);
    expect(result).toMatchObject({ ok: false, field: "sessionChoice" });
  });

  it("points at the custom field when the custom number is missing or out of range", () => {
    expect(
      resolvePairPreferences(submit({ sessionChoice: "custom" }), POLICY),
    ).toMatchObject({ ok: false, field: "sessionCustom" });
    expect(
      resolvePairPreferences(
        submit({ sessionChoice: "custom", sessionCustom: "5" }),
        POLICY,
      ),
    ).toMatchObject({ ok: false, field: "sessionCustom", message: /15 and 240/ });
    expect(
      resolvePairPreferences(
        submit({ cadenceChoice: "custom", cadenceCustom: "2.5" }),
        POLICY,
      ),
    ).toMatchObject({ ok: false, field: "cadenceCustom" });
    expect(
      resolvePairPreferences(
        submit({ cadenceChoice: "custom", cadenceCustom: "0" }),
        POLICY,
      ),
    ).toMatchObject({ ok: false, field: "cadenceCustom" });
  });

  it("does not silently drop a custom number typed with no 'Custom' selected", () => {
    expect(
      resolvePairPreferences(submit({ sessionCustom: "50" }), POLICY),
    ).toMatchObject({ ok: false, field: "sessionChoice" });
  });

  it("refuses custom when the program does not offer it", () => {
    const fixed = PairPreferencesPolicySchema.parse({
      allowCustomSessionMinutes: false,
    });
    expect(
      resolvePairPreferences(
        submit({ sessionChoice: "custom", sessionCustom: "60" }),
        fixed,
      ),
    ).toMatchObject({ ok: false, field: "sessionChoice" });
  });

  it("refuses everything when the program sets length and rhythm itself", () => {
    const off = PairPreferencesPolicySchema.parse({ enabled: false });
    expect(
      resolvePairPreferences(submit({ sessionChoice: "30" }), off),
    ).toMatchObject({ ok: false });
  });

  it("refuses an empty submission rather than recording a no-op change", () => {
    expect(resolvePairPreferences(submit(), POLICY)).toMatchObject({ ok: false });
  });
});

describe("applyPairPreferences", () => {
  it("merges onto an existing override, moving only what the pair touched", () => {
    const fromRoster = { everyDays: 30, label: "monthly" };
    expect(applyPairPreferences(fromRoster, { sessionMinutes: 15 })).toEqual({
      everyDays: 30,
      label: "monthly",
      sessionMinutes: 15,
    });
  });

  it("keeps the label in step with the rhythm, so copy never lies about it", () => {
    expect(applyPairPreferences(null, { everyDays: 21 })).toEqual({
      everyDays: 21,
      label: "three-weekly",
    });
  });

  it("wins over program and cohort in resolveCadence — the pair level is merged last", () => {
    const program = defaultPolicy().cadence;
    const cohort = { everyDays: 30, label: "monthly", sessionMinutes: 60 };
    const pair = applyPairPreferences(null, { sessionMinutes: 30, everyDays: 7 });
    const resolved = resolveCadence(program, cohort, pair);
    expect(resolved).toMatchObject({
      sessionMinutes: 30,
      everyDays: 7,
      label: "weekly",
    });
  });
});

describe("labels", () => {
  it("names the common rhythms and falls back to a count of days", () => {
    expect(cadenceLabelFor(7)).toBe("weekly");
    expect(cadenceLabelFor(14)).toBe("fortnightly");
    expect(cadenceLabelFor(28)).toBe("four-weekly");
    expect(cadenceLabelFor(10)).toBe("every 10 days");
  });

  it("describes both halves in plain words", () => {
    expect(describeCadence({ sessionMinutes: 30, everyDays: 14 })).toBe(
      "30-minute sessions, every 2 weeks",
    );
    expect(describeCadence({ sessionMinutes: 45, everyDays: 10 })).toBe(
      "45-minute sessions, every 10 days",
    );
    expect(describeCadence({ sessionMinutes: 45, everyDays: 0 })).toBe(
      "45-minute sessions, ad hoc",
    );
  });
});
