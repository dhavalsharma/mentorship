import { describe, expect, it } from "vitest";
import {
  deficitDedupeKey,
  isoWeek,
  sweep,
  toEventInput,
  type SweepInput,
} from "@mentorship/primitive-nudge";

/**
 * The sweep is the half of the system that has no other way of being tested:
 * every case here is a moment at which nothing happened, and the only way to
 * see the difference between "not yet" and "now" is to run the same input at
 * two values of `now`.
 */

const NOW = "2026-09-15T12:00:00.000Z";

const pair = (over: Partial<NonNullable<SweepInput["pairs"]>[number]> = {}) => ({
  pairingId: "p_001",
  orgId: "org_1",
  state: "active" as const,
  cadenceEveryDays: 14,
  activatedAt: "2026-08-01T09:00:00.000Z",
  lastSessionAt: "2026-09-01T12:00:00.000Z",
  ...over,
});

const input = (over: Partial<SweepInput> = {}): SweepInput => ({
  now: NOW,
  pairs: [pair()],
  ...over,
});

describe("sweep — cadence", () => {
  it("is silent while the pair is merely due, and speaks once the grace is spent", () => {
    // Due 2026-09-15 (14 days after the last session), grace 2 days.
    expect(sweep(input({ now: "2026-09-15T12:00:00.000Z" }))).toHaveLength(0);
    expect(sweep(input({ now: "2026-09-17T11:59:59.000Z" }))).toHaveLength(0);

    const found = sweep(input({ now: "2026-09-17T12:00:00.000Z" }));
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("pair.cadence_deficit");
    expect(found[0]!.subjectRef).toBe("pairing:p_001");
    expect(found[0]!.overdueDays).toBe(2);
  });

  it("runs the clock from activation when the pair has never met at all", () => {
    const never = input({
      pairs: [pair({ lastSessionAt: null, activatedAt: "2026-08-01T09:00:00.000Z" })],
      now: "2026-08-20T09:00:00.000Z",
    });
    const found = sweep(never);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail.everMet).toBe(false);
  });

  it("says nothing when a session is already on the calendar", () => {
    const booked = input({
      now: "2026-09-20T12:00:00.000Z",
      pairs: [pair({ nextScheduledSessionAt: "2026-09-22T10:00:00.000Z" })],
    });
    expect(sweep(booked)).toHaveLength(0);

    // A session in the past does not count — that is what lastSessionAt is for.
    const stale = input({
      now: "2026-09-20T12:00:00.000Z",
      pairs: [pair({ nextScheduledSessionAt: "2026-09-02T10:00:00.000Z" })],
    });
    expect(sweep(stale)).toHaveLength(1);
  });

  it("leaves ad-hoc programs alone — no cadence means no expectation to miss", () => {
    const adhoc = input({
      now: "2027-01-01T00:00:00.000Z",
      pairs: [pair({ cadenceEveryDays: 0 })],
    });
    expect(sweep(adhoc)).toHaveLength(0);
  });

  it("does not chase a paused pair", () => {
    for (const state of ["paused", "completed", "ended_early", "offered"] as const) {
      const off = input({ now: "2026-10-30T12:00:00.000Z", pairs: [pair({ state })] });
      expect(sweep(off), state).toHaveLength(0);
    }
  });

  it("grades severity against the pair's own cadence, not an absolute", () => {
    const at = (now: string) => sweep(input({ now }))[0]!.severity;
    expect(at("2026-09-18T12:00:00.000Z")).toBe("low"); // 3 of 14 days late
    expect(at("2026-09-23T12:00:00.000Z")).toBe("medium"); // 8 of 14
    expect(at("2026-09-30T12:00:00.000Z")).toBe("high"); // a full cycle missed
  });

  it("passes through who the pair is waiting on, and never invents one", () => {
    const known = sweep(
      input({
        now: "2026-09-20T12:00:00.000Z",
        pairs: [pair({ blockedOnParticipantId: "pt_mentor" })],
      }),
    );
    expect(known[0]!.blockedOnParticipantId).toBe("pt_mentor");
    expect(sweep(input({ now: "2026-09-20T12:00:00.000Z" }))[0]!.blockedOnParticipantId).toBeNull();
  });
});

describe("sweep — action items, goals and surveys", () => {
  const overdueNow = "2026-09-15T12:00:00.000Z";

  it("flags an action item the instant it is past due, and not at the due moment", () => {
    const base = {
      actionItemId: "ai_1",
      pairingId: "p_001",
      orgId: "org_1",
      ownerParticipantId: "pt_mentee",
      dueAt: overdueNow,
    };
    expect(
      sweep(input({ now: overdueNow, actionItems: [base] })).filter(
        (d) => d.name === "action_item.overdue",
      ),
    ).toHaveLength(0);

    const later = sweep(
      input({ now: "2026-09-15T12:00:01.000Z", actionItems: [base] }),
    ).filter((d) => d.name === "action_item.overdue");
    expect(later).toHaveLength(1);
    // The owner is a fact here, not a guess — this is the deficit that most
    // often names the wrong person if you let something infer it.
    expect(later[0]!.blockedOnParticipantId).toBe("pt_mentee");
    expect(later[0]!.subjectRef).toBe("action_item:ai_1");
  });

  it("ignores a closed action item and one belonging to an inactive pair", () => {
    const rows = [
      {
        actionItemId: "ai_done",
        pairingId: "p_001",
        orgId: "org_1",
        ownerParticipantId: "pt_1",
        dueAt: "2026-09-01T00:00:00.000Z",
        status: "done" as const,
      },
      {
        actionItemId: "ai_orphan",
        pairingId: "p_999",
        orgId: "org_1",
        ownerParticipantId: "pt_1",
        dueAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    expect(
      sweep(input({ actionItems: rows })).filter((d) => d.name === "action_item.overdue"),
    ).toHaveLength(0);
  });

  it("calls a goal stale 21 days after the last check-in, counting from creation if there was none", () => {
    const goal = {
      goalId: "g_1",
      pairingId: "p_001",
      orgId: "org_1",
      ownerParticipantId: "pt_mentee",
      createdAt: "2026-08-25T12:00:00.000Z",
      lastCheckInAt: null,
    };
    expect(
      sweep(input({ now: "2026-09-15T11:00:00.000Z", goals: [goal] })).filter(
        (d) => d.name === "goal.stale",
      ),
    ).toHaveLength(0);

    const stale = sweep(input({ now: "2026-09-15T12:00:00.000Z", goals: [goal] })).filter(
      (d) => d.name === "goal.stale",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail.daysSinceTouch).toBe(21);

    // A check-in resets the clock, which is the whole point of check-ins.
    const touched = sweep(
      input({
        now: "2026-09-15T12:00:00.000Z",
        goals: [{ ...goal, lastCheckInAt: "2026-09-10T12:00:00.000Z" }],
      }),
    );
    expect(touched.filter((d) => d.name === "goal.stale")).toHaveLength(0);
  });

  it("flags an unanswered survey after 72 hours, and never an answered one", () => {
    const survey = {
      surveyId: "sv_1",
      pairingId: "p_001",
      orgId: "org_1",
      participantId: "pt_mentee",
      sentAt: "2026-09-12T12:00:00.000Z",
    };
    expect(
      sweep(input({ now: "2026-09-15T11:59:00.000Z", surveys: [survey] })).filter(
        (d) => d.name === "survey.unanswered",
      ),
    ).toHaveLength(0);

    const unanswered = sweep(input({ surveys: [survey] })).filter(
      (d) => d.name === "survey.unanswered",
    );
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0]!.blockedOnParticipantId).toBe("pt_mentee");

    const answered = sweep(
      input({ surveys: [{ ...survey, answeredAt: "2026-09-13T08:00:00.000Z" }] }),
    );
    expect(answered.filter((d) => d.name === "survey.unanswered")).toHaveLength(0);
  });

  it("honours caller-supplied thresholds, because grace is a program's call", () => {
    const survey = {
      surveyId: "sv_1",
      pairingId: "p_001",
      orgId: "org_1",
      participantId: "pt_mentee",
      sentAt: "2026-09-12T12:00:00.000Z",
    };
    const patient = sweep(
      input({ surveys: [survey], thresholds: { surveyUnansweredHours: 168 } }),
    );
    expect(patient.filter((d) => d.name === "survey.unanswered")).toHaveLength(0);
  });
});

describe("sweep — idempotence and ordering", () => {
  it("does not re-emit a deficit whose key has already been seen", () => {
    const late = { ...input({ now: "2026-09-20T12:00:00.000Z" }) };
    const first = sweep(late);
    expect(first).toHaveLength(1);
    const second = sweep({ ...late, alreadyEmitted: [first[0]!.dedupeKey] });
    expect(second).toHaveLength(0);
  });

  it("keys an absence to its ISO week, so a daily sweep is not a daily nudge", () => {
    const monday = sweep(input({ now: "2026-09-21T09:00:00.000Z" }))[0]!;
    const friday = sweep(input({ now: "2026-09-25T09:00:00.000Z" }))[0]!;
    const nextWeek = sweep(input({ now: "2026-09-28T09:00:00.000Z" }))[0]!;
    expect(friday.dedupeKey).toBe(monday.dedupeKey);
    expect(nextWeek.dedupeKey).not.toBe(monday.dedupeKey);
  });

  it("computes ISO weeks, including the year-boundary case that always breaks", () => {
    expect(isoWeek("2026-09-15T00:00:00.000Z")).toBe("2026-W38");
    // 2027-01-01 is a Friday, so it belongs to the last week of 2026.
    expect(isoWeek("2027-01-01T00:00:00.000Z")).toBe("2026-W53");
    expect(isoWeek("2026-01-01T00:00:00.000Z")).toBe("2026-W01");
  });

  it("returns a stable order, so two sweeps of the same world are comparable", () => {
    const mixed = sweep(
      input({
        now: "2026-09-25T12:00:00.000Z",
        actionItems: [
          {
            actionItemId: "ai_2",
            pairingId: "p_001",
            orgId: "org_1",
            ownerParticipantId: "pt_1",
            dueAt: "2026-09-01T00:00:00.000Z",
          },
          {
            actionItemId: "ai_1",
            pairingId: "p_001",
            orgId: "org_1",
            ownerParticipantId: "pt_1",
            dueAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        surveys: [
          {
            surveyId: "sv_1",
            pairingId: "p_001",
            orgId: "org_1",
            participantId: "pt_1",
            sentAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(mixed.map((d) => d.subjectRef)).toEqual([
      "pairing:p_001",
      "action_item:ai_1",
      "action_item:ai_2",
      "survey:sv_1",
    ]);
  });

  it("builds a dedupe key a nudge can be keyed on too", () => {
    expect(
      deficitDedupeKey({
        subjectRef: "pairing:p_001",
        name: "pair.cadence_deficit",
        at: "2026-09-15T00:00:00.000Z",
      }),
    ).toBe("pairing:p_001:cadence_deficit:2026-W38");
  });

  it("converts to an event the sink can write without reshaping", () => {
    const deficit = sweep(input({ now: "2026-09-20T12:00:00.000Z" }))[0]!;
    const event = toEventInput(deficit);
    expect(event.name).toBe("pair.cadence_deficit");
    expect(event.subjectRef).toBe("pairing:p_001");
    expect(event.payload.pairingId).toBe("p_001");
    expect(event.payload.expectedEveryDays).toBe(14);
  });
});
