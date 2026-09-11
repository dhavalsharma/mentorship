import { describe, expect, it } from "vitest";
import {
  recordResponse,
  resolveAgreement,
  roundsExhausted,
  type Agreement,
  type AgreementPolicy,
  type AgreementResponse,
} from "@mentorship/core";

const POLICY: AgreementPolicy = {
  resolution: "require_both",
  maxRounds: 2,
  responseTimeoutHours: 48,
  renudgeAfterHours: 48,
  escalateAfterHours: 96,
};

const OPENED = "2026-09-11T06:00:00.000Z";
const TIMEOUT = "2026-09-13T06:00:00.000Z";
const BEFORE = new Date("2026-09-12T06:00:00.000Z");
const AFTER = new Date("2026-09-14T06:00:00.000Z");

function agreement(over: Partial<Agreement> = {}): Agreement {
  return {
    id: "agr_1",
    subject: "session_time",
    pairingId: "pai_1",
    participantIds: ["p_mentor", "p_mentee"],
    options: [
      { optionId: "opt_1", startsAt: OPENED, endsAt: OPENED, label: "Mon" },
      { optionId: "opt_2", startsAt: OPENED, endsAt: OPENED, label: "Tue" },
    ],
    responses: [],
    round: 1,
    openedAt: OPENED,
    timeoutAt: TIMEOUT,
    ...over,
  };
}

const accept = (who: string, optionId: string, at = BEFORE.toISOString()) =>
  ({ participantId: who, kind: "accept", optionId, at }) as AgreementResponse;

describe("resolveAgreement", () => {
  it("is pending while one party has not answered", () => {
    const a = agreement({ responses: [accept("p_mentor", "opt_2")] });
    expect(resolveAgreement(a, POLICY, BEFORE)).toEqual({
      status: "pending",
      awaiting: ["p_mentee"],
    });
  });

  it("accepts when both pick the same option", () => {
    const a = agreement({
      responses: [accept("p_mentor", "opt_2"), accept("p_mentee", "opt_2")],
    });
    expect(resolveAgreement(a, POLICY, BEFORE)).toEqual({
      status: "accepted",
      optionId: "opt_2",
      unanimous: true,
    });
  });

  it("reports a conflict when both say yes to different slots", () => {
    const a = agreement({
      responses: [accept("p_mentor", "opt_1"), accept("p_mentee", "opt_2")],
    });
    const result = resolveAgreement(a, POLICY, BEFORE);
    expect(result.status).toBe("conflict");
  });

  it("a decline beats everything else", () => {
    const a = agreement({
      responses: [
        accept("p_mentor", "opt_1"),
        {
          participantId: "p_mentee",
          kind: "decline",
          at: BEFORE.toISOString(),
        },
      ],
    });
    expect(resolveAgreement(a, POLICY, BEFORE)).toEqual({
      status: "declined",
      by: "p_mentee",
    });
  });

  it("surfaces the earliest counter so the outcome is order-independent", () => {
    const counter = {
      optionId: "opt_x",
      startsAt: OPENED,
      endsAt: OPENED,
      label: "Thu",
    };
    const a = agreement({
      responses: [
        {
          participantId: "p_mentee",
          kind: "counter",
          counter,
          at: "2026-09-12T09:00:00.000Z",
        },
        {
          participantId: "p_mentor",
          kind: "counter",
          counter: { ...counter, label: "Fri" },
          at: "2026-09-12T10:00:00.000Z",
        },
      ],
    });
    const result = resolveAgreement(a, POLICY, BEFORE);
    expect(result).toMatchObject({ status: "countered", by: "p_mentee" });
  });

  it("stalls with no_response when the window closes in silence", () => {
    expect(resolveAgreement(agreement(), POLICY, AFTER)).toEqual({
      status: "stalled",
      reason: "no_response",
    });
  });

  it("stalls on a one-sided reply under require_both", () => {
    const a = agreement({ responses: [accept("p_mentor", "opt_1")] });
    expect(resolveAgreement(a, POLICY, AFTER)).toEqual({
      status: "stalled",
      reason: "partial_response",
    });
  });

  it("proceeds on one reply when the program prefers over-scheduling", () => {
    const a = agreement({ responses: [accept("p_mentor", "opt_1")] });
    const result = resolveAgreement(
      a,
      { ...POLICY, resolution: "proceed_on_one" },
      AFTER,
    );
    expect(result).toEqual({
      status: "accepted",
      optionId: "opt_1",
      unanimous: false,
    });
  });

  it("lets a participant change their mind — last response wins", () => {
    const a = agreement({
      responses: [
        accept("p_mentor", "opt_1", "2026-09-12T06:00:00.000Z"),
        accept("p_mentor", "opt_2", "2026-09-12T08:00:00.000Z"),
        accept("p_mentee", "opt_2", "2026-09-12T09:00:00.000Z"),
      ],
    });
    expect(resolveAgreement(a, POLICY, BEFORE)).toMatchObject({
      status: "accepted",
      optionId: "opt_2",
    });
  });

  it("rejects a response from someone who is not a party", () => {
    expect(() =>
      recordResponse(agreement(), accept("p_stranger", "opt_1")),
    ).toThrow(/not a party/);
  });

  it("rejects an accept for an option that was never offered", () => {
    expect(() =>
      recordResponse(agreement(), accept("p_mentor", "opt_nope")),
    ).toThrow(/unknown option/);
  });

  it("caps negotiation rounds", () => {
    expect(roundsExhausted(agreement({ round: 1 }), POLICY)).toBe(false);
    expect(roundsExhausted(agreement({ round: 2 }), POLICY)).toBe(true);
  });
});
