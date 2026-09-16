import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import { DeterministicProvider, NullAiRunSink } from "@mentorship/ai";
import { ThompsonBandit, runNudgeSweep, seededRng } from "@mentorship/primitive-nudge";
import type {
  Deficit,
  NudgeDispatchSink,
  NudgePlanDraft,
  NudgeReader,
  NudgeRecordSink,
} from "@mentorship/primitive-nudge";
import { FakeNudgeReader, MENTOR, cadenceDeficit, pairView, recipient } from "./fixtures.js";

/**
 * `runNudgeSweep` end to end: the loop a scheduler would call, mirroring
 * `runProgressSweep`'s test — one planner run per deficit, dispatched only
 * when the gate chain lets it through, recorded regardless of outcome, and
 * one recipient's dispatch failure never costing another.
 */

const policy = defaultPolicy({});

const draft = (over: Partial<NudgePlanDraft> = {}): NudgePlanDraft => ({
  shouldNudge: true,
  recipientParticipantId: "pt_mentor",
  templateId: "cadence.gentle.offer",
  channel: "dm",
  tone: "gentle",
  body: "Sam — want me to find a time with Priya this week?",
  rationale: "Sam has not replied since August",
  evidenceQuotes: ["WAITING_ON id=pt_mentor"],
  ...over,
});

const provider = (value: unknown) => new DeterministicProvider({ fallbackValue: value });

interface RecordedNudge {
  orgId: string;
  pairingId: string;
  recipientParticipantId: string | null;
  channel: string;
  state: "planned" | "sent" | "dropped";
  escalationLevel: number;
  body: string;
  dedupeKey: string;
  droppedReason: string | null;
  sentAt: string | null;
}

class FakeDispatchSink implements NudgeDispatchSink {
  sent: { channel: string; recipientParticipantId: string; body: string }[] = [];
  private readonly failFor: Set<string>;

  constructor(failFor: string[] = []) {
    this.failFor = new Set(failFor);
  }

  async send(input: { channel: string; recipientParticipantId: string; body: string }) {
    if (this.failFor.has(input.recipientParticipantId)) {
      throw new Error(`delivery down for ${input.recipientParticipantId}`);
    }
    this.sent.push(input);
  }
}

class FakeRecordSink implements NudgeRecordSink {
  written: RecordedNudge[] = [];
  async record(input: RecordedNudge) {
    this.written.push(input);
  }
}

function sweepOf(over: {
  deficits: Deficit[];
  llm: DeterministicProvider;
  dispatch?: FakeDispatchSink;
  record?: FakeRecordSink;
  reader?: FakeNudgeReader;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}) {
  const dispatch = over.dispatch ?? new FakeDispatchSink();
  const record = over.record ?? new FakeRecordSink();
  return {
    dispatch,
    record,
    run: () =>
      runNudgeSweep({
        deficits: over.deficits,
        reader: over.reader ?? new FakeNudgeReader({}),
        llm: over.llm,
        policy,
        orgId: "org_1",
        dispatch,
        record,
        runs: new NullAiRunSink(),
        bandit: new ThompsonBandit(seededRng(7)),
        ...(over.onWarn ? { onWarn: over.onWarn } : {}),
      }),
  };
}

describe("runNudgeSweep — the sending path", () => {
  it("dispatches a nudge that passes every gate and records it as sent", async () => {
    const deficit = cadenceDeficit({ blockedOnParticipantId: "pt_mentor" });
    const { dispatch, record, run } = sweepOf({
      deficits: [deficit],
      llm: provider(draft()),
    });

    const result = await run();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      dedupeKey: deficit.dedupeKey,
      pairingId: deficit.pairingId,
      gate: "auto",
      outcome: "send",
      dispatched: true,
      dispatchError: null,
    });

    expect(dispatch.sent).toHaveLength(1);
    expect(dispatch.sent[0]).toMatchObject({
      channel: "dm",
      recipientParticipantId: "pt_mentor",
    });

    expect(record.written).toHaveLength(1);
    expect(record.written[0]).toMatchObject({
      orgId: "org_1",
      pairingId: deficit.pairingId,
      recipientParticipantId: "pt_mentor",
      state: "sent",
      dedupeKey: deficit.dedupeKey,
      droppedReason: null,
    });
    expect(record.written[0]!.sentAt).not.toBeNull();
  });
});

describe("runNudgeSweep — the gate chain has the last word", () => {
  it("never dispatches to a muted recipient, and records the drop", async () => {
    const deficit = cadenceDeficit({ blockedOnParticipantId: "pt_mentor" });
    const muted = pairView({ recipients: [recipient(), { ...MENTOR, muted: true }] });
    const { dispatch, record, run } = sweepOf({
      deficits: [deficit],
      llm: provider(draft()),
      reader: new FakeNudgeReader({ pair: muted }),
    });

    const result = await run();

    expect(result.entries[0]).toMatchObject({ outcome: "drop", dispatched: false });
    expect(dispatch.sent).toEqual([]);
    expect(record.written).toHaveLength(1);
    expect(record.written[0]).toMatchObject({
      state: "dropped",
      recipientParticipantId: "pt_mentor",
    });
    expect(record.written[0]!.droppedReason).toMatch(/muted/);
    expect(record.written[0]!.sentAt).toBeNull();
  });
});

describe("runNudgeSweep — isolation", () => {
  it("does not lose a second, independent nudge when the first fails to dispatch", async () => {
    const first = cadenceDeficit({
      subjectRef: "pairing:p_001",
      pairingId: "p_001",
      dedupeKey: "pairing:p_001:cadence_deficit:2026-W39",
      blockedOnParticipantId: "pt_mentor",
    });
    const second = cadenceDeficit({
      subjectRef: "pairing:p_002",
      pairingId: "p_002",
      dedupeKey: "pairing:p_002:cadence_deficit:2026-W39",
      blockedOnParticipantId: "pt_mentor",
    });

    const dispatch = new FakeDispatchSink(["pt_mentor"]);
    const record = new FakeRecordSink();
    let calls = 0;
    const { run } = sweepOf({
      deficits: [first, second],
      llm: provider(draft()),
      dispatch,
      record,
      onWarn: () => {
        calls++;
      },
    });

    const result = await run();

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.outcome === "send")).toBe(true);
    expect(result.entries.every((e) => !e.dispatched)).toBe(true);
    expect(result.entries.every((e) => e.dispatchError?.includes("delivery down"))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);

    // Both decisions are still recorded — as `planned`, never falsely `sent` —
    // so neither absence is silently dropped from the next sweep's dedupe.
    expect(record.written).toHaveLength(2);
    expect(record.written.every((w) => w.state === "planned")).toBe(true);
    expect(record.written.map((w) => w.dedupeKey).sort()).toEqual(
      [first.dedupeKey, second.dedupeKey].sort(),
    );
  });

  it("isolates one deficit whose own processing throws from the rest of the sweep", async () => {
    const good = cadenceDeficit({ blockedOnParticipantId: "pt_mentor" });
    const broken = cadenceDeficit({
      subjectRef: "pairing:p_broken",
      pairingId: "p_broken",
      dedupeKey: "pairing:p_broken:cadence_deficit:2026-W39",
    });

    const record = new FakeRecordSink();
    const reader: NudgeReader = new FakeNudgeReader({});
    const brokenReader = {
      pair: async (id: string) => {
        if (id === "p_broken") throw new Error("reader outage");
        return reader.pair(id);
      },
      history: reader.history.bind(reader),
      templateStats: reader.templateStats.bind(reader),
      subjectLabel: reader.subjectLabel.bind(reader),
    };

    const warnings: string[] = [];
    const result = await runNudgeSweep({
      deficits: [broken, good],
      reader: brokenReader,
      llm: provider(draft()),
      policy,
      orgId: "org_1",
      dispatch: new FakeDispatchSink(),
      record,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.pairingId).toBe(good.pairingId);
    expect(warnings.some((w) => w.includes("failed for one deficit"))).toBe(true);
    expect(record.written.some((w) => w.pairingId === good.pairingId)).toBe(true);
  });
});

describe("runNudgeSweep — nothing to do", () => {
  it("does nothing given zero deficits", async () => {
    const { dispatch, record, run } = sweepOf({ deficits: [], llm: provider(draft()) });
    const result = await run();
    expect(result.entries).toEqual([]);
    expect(dispatch.sent).toEqual([]);
    expect(record.written).toEqual([]);
  });
});
