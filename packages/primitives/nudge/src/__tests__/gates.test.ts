import { describe, expect, it } from "vitest";
import {
  applyGates,
  inQuietHours,
  quietHoursEndAt,
  type NudgePlan,
} from "@mentorship/primitive-nudge";
import { NOW, cadenceDeficit, context, history, pairView, recipient } from "./fixtures.js";

/**
 * Every gate, blocking on its own. The chain is the only thing standing
 * between a helpful assistant and a muted one, so each filter is tested in
 * isolation rather than trusted because the happy path works.
 */

const plan = (over: Partial<NudgePlan> = {}): NudgePlan => ({
  recipientParticipantId: "pt_mentee",
  recipientRole: "mentee",
  channel: "dm",
  tone: "gentle",
  templateId: "cadence.gentle.streak",
  body: "Time for a catch-up?",
  rationale: "quietest party",
  evidence: [],
  ...over,
});

const gateNamed = (results: ReturnType<typeof applyGates>["results"], name: string) =>
  results.find((r) => r.gate === name)!;

describe("gate chain — the clean path", () => {
  it("passes every gate and blocks nothing when there is nothing wrong", () => {
    const outcome = applyGates({ plan: plan(), ctx: context(), recipient: recipient() });
    expect(outcome.blocked).toBeNull();
    expect(outcome.results.map((r) => r.gate)).toEqual([
      "mute",
      "dedupe",
      "privacy",
      "already_booked",
      "rate_limit",
      "quiet_hours",
    ]);
    expect(outcome.results.every((r) => r.passed)).toBe(true);
  });
});

describe("gate chain — mute", () => {
  it("never messages a muted recipient", () => {
    const outcome = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({ muted: true }),
    });
    expect(outcome.blocked?.gate).toBe("mute");
  });

  it("honours a live snooze and lets an expired one through", () => {
    const live = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({ snoozedUntil: "2026-09-30T00:00:00.000Z" }),
    });
    expect(live.blocked?.gate).toBe("mute");
    expect(live.nextEligibleAt).toBe("2026-09-30T00:00:00.000Z");

    const expired = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({ snoozedUntil: "2026-09-01T00:00:00.000Z" }),
    });
    expect(gateNamed(expired.results, "mute").passed).toBe(true);
  });

  it("is reported first when several gates fail, because it is the one that matters", () => {
    const outcome = applyGates({
      plan: plan({ channel: "thread" }),
      ctx: context({ history: history({ sentDedupeKeys: [cadenceDeficit().dedupeKey] }) }),
      recipient: recipient({ muted: true, nudgesLast7Days: 9 }),
    });
    expect(outcome.blocked?.gate).toBe("mute");
    expect(outcome.results.filter((r) => !r.passed).map((r) => r.gate)).toEqual([
      "mute",
      "dedupe",
      "privacy",
      "rate_limit",
    ]);
  });
});

describe("gate chain — dedupe", () => {
  it("refuses to send the same nudge twice", () => {
    const key = cadenceDeficit().dedupeKey;
    const outcome = applyGates({
      plan: plan(),
      ctx: context({ history: history({ sentDedupeKeys: [key] }) }),
      recipient: recipient(),
    });
    expect(outcome.blocked?.gate).toBe("dedupe");
    expect(outcome.blocked?.reason).toContain(key);
  });
});

describe("gate chain — privacy (invariant 13)", () => {
  it("drops a one-to-one nudge aimed at the joint thread rather than sending it there", () => {
    const outcome = applyGates({
      plan: plan({ channel: "thread" }),
      ctx: context(),
      recipient: recipient(),
    });
    expect(outcome.blocked?.gate).toBe("privacy");
    expect(outcome.blocked?.reason).toMatch(/dm-only/);
  });

  it("drops rather than falling back when the private channel is unavailable", () => {
    const outcome = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({ channels: ["thread"] }),
    });
    expect(outcome.blocked?.gate).toBe("privacy");
    // The point of the test: no second-best channel is offered anywhere in
    // the result. A private message that lands in front of the other
    // participant is worse than one that is not sent.
    expect(JSON.stringify(outcome)).not.toContain("fallback");
  });
});

describe("gate chain — already booked", () => {
  it("drops a cadence nudge once a future session exists", () => {
    const outcome = applyGates({
      plan: plan(),
      ctx: context({ pair: pairView({ nextScheduledSessionAt: "2026-09-25T10:00:00.000Z" }) }),
      recipient: recipient(),
    });
    expect(outcome.blocked?.gate).toBe("already_booked");
  });

  it("ignores a past session — that is what the deficit was computed from", () => {
    const outcome = applyGates({
      plan: plan(),
      ctx: context({ pair: pairView({ nextScheduledSessionAt: "2026-09-01T10:00:00.000Z" }) }),
      recipient: recipient(),
    });
    expect(outcome.blocked).toBeNull();
  });

  it("does not silence an overdue action item just because a meeting is booked", () => {
    const outcome = applyGates({
      plan: plan(),
      ctx: context({
        deficit: cadenceDeficit({
          name: "action_item.overdue",
          subjectRef: "action_item:ai_1",
        }),
        pair: pairView({ nextScheduledSessionAt: "2026-09-25T10:00:00.000Z" }),
      }),
      recipient: recipient(),
    });
    expect(outcome.blocked).toBeNull();
    expect(gateNamed(outcome.results, "already_booked").reason).toMatch(/not a scheduling/);
  });
});

describe("gate chain — rate limit", () => {
  it("blocks at the limit and passes below it", () => {
    const at = (n: number) =>
      applyGates({
        plan: plan(),
        ctx: context(),
        recipient: recipient({ nudgesLast7Days: n }),
      });
    expect(at(2).blocked).toBeNull();
    expect(at(3).blocked?.gate).toBe("rate_limit");
    expect(at(3).blocked?.reason).toContain("limit 3");
  });

  it("counts per person, so the recipient's other pairs count against it", () => {
    // A mentor with six mentees is still one inbox. The limit lives on the
    // recipient, not the pairing, and this is the test that says so.
    const outcome = applyGates({
      plan: plan({ recipientParticipantId: "pt_mentor", recipientRole: "mentor" }),
      ctx: context(),
      recipient: recipient({ participantId: "pt_mentor", nudgesLast7Days: 5 }),
    });
    expect(outcome.blocked?.gate).toBe("rate_limit");
  });
});

describe("gate chain — quiet hours, in the recipient's own timezone", () => {
  it("lets the same instant through for one party and blocks it for the other", () => {
    // 14:00 UTC is a civil hour in London and 03:00 the next morning in
    // Auckland. Evaluating this in the server's zone is the classic bug.
    const london = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({ tzOffsetMinutes: 0 }),
    });
    expect(london.blocked).toBeNull();

    const auckland = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({ tzOffsetMinutes: 13 * 60 }),
    });
    expect(auckland.blocked?.gate).toBe("quiet_hours");
    expect(auckland.nextEligibleAt).toBe("2026-09-21T19:00:00.000Z"); // 08:00 local
  });

  it("respects a recipient's own window rather than the program default", () => {
    const earlyRiser = applyGates({
      plan: plan(),
      ctx: context(),
      recipient: recipient({
        tzOffsetMinutes: 13 * 60,
        quietHours: { startHour: 0, endHour: 2 },
      }),
    });
    expect(earlyRiser.blocked).toBeNull();
  });

  it("handles a window that wraps midnight and one that does not", () => {
    const night = { startHour: 21, endHour: 8 };
    const ms = Date.parse(NOW);
    expect(inQuietHours(ms, 0, night)).toBe(false); // 14:00 local
    expect(inQuietHours(ms, 6 * 60, night)).toBe(false); // 20:00 local
    expect(inQuietHours(ms, 8 * 60, night)).toBe(true); // 22:00 local
    expect(inQuietHours(ms, 10 * 60, night)).toBe(true); // 00:00 local
    expect(inQuietHours(ms, -8 * 60, night)).toBe(true); // 06:00 local, still night
    expect(inQuietHours(ms, -4 * 60, night)).toBe(false); // 10:00 local

    const siesta = { startHour: 13, endHour: 15 };
    expect(inQuietHours(ms, 0, siesta)).toBe(true);
    expect(inQuietHours(ms, 60, siesta)).toBe(false); // 15:00, window is half-open
    expect(inQuietHours(ms, 0, { startHour: 9, endHour: 9 })).toBe(false); // empty
  });

  it("reports the next civil moment in the recipient's zone, as information only", () => {
    const ms = Date.parse(NOW);
    expect(quietHoursEndAt(ms, 10 * 60, { startHour: 21, endHour: 8 })).toBe(
      "2026-09-21T22:00:00.000Z", // 08:00 the next morning, UTC+10
    );
  });
});
