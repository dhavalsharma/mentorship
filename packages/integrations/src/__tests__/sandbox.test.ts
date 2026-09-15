import { describe, expect, it, vi } from "vitest";
import {
  FakeCalendar,
  FakeConversation,
  FakeDm,
  guardAdapter,
  guardCalendar,
  guardConversation,
  guardDm,
  Recorder,
  SandboxGuard,
  SandboxRefusal,
} from "@mentorship/integrations";

/**
 * The guard only matters on the day someone points this at a real workspace,
 * which is exactly the day nobody wants to discover it was wired up wrong.
 */

const ALLOW = ["dhavals+mentor@wekancode.com", "U-TEST-A", "U-TEST-B"];

function guard(onRefused?: (d: { adapter: string; refused: string[] }) => void) {
  return new SandboxGuard({
    allowlist: ALLOW,
    ...(onRefused ? { onRefused } : {}),
  });
}

describe("the sandbox guard", () => {
  it("refuses to be constructed with an empty allowlist", () => {
    expect(() => new SandboxGuard({ allowlist: [] })).toThrow(/refusing/);
  });

  it("lets an allowlisted thread through", async () => {
    const recorder = new Recorder();
    const adapter = guardConversation(new FakeConversation(recorder), guard());
    await expect(
      adapter.ensureThread({
        pairingId: "p1",
        memberRefs: ["U-TEST-A", "U-TEST-B"],
        title: "Mentoring",
      }),
    ).resolves.toBeDefined();
  });

  it("stops a thread that would include a real colleague", async () => {
    const onRefused = vi.fn();
    const recorder = new Recorder();
    const adapter = guardConversation(
      new FakeConversation(recorder),
      guard(onRefused),
    );

    await expect(
      adapter.ensureThread({
        pairingId: "p1",
        memberRefs: ["U-TEST-A", "U-REAL-COLLEAGUE"],
        title: "Mentoring",
      }),
    ).rejects.toBeInstanceOf(SandboxRefusal);

    expect(onRefused).toHaveBeenCalledWith({
      adapter: "fake-chat.ensureThread",
      refused: ["U-REAL-COLLEAGUE"],
    });
    // Nothing reached the adapter.
    expect(recorder.calls).toHaveLength(0);
  });

  it("stops a DM to someone not on the list", async () => {
    const recorder = new Recorder();
    const adapter = guardDm(new FakeDm(recorder), guard());
    await expect(
      adapter.send({ memberRef: "U-NOBODY", body: "hi", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(SandboxRefusal);
    expect(recorder.calls).toHaveLength(0);
  });

  it("stops the calendar invite — the one that sends mail", async () => {
    const recorder = new Recorder();
    const adapter = guardCalendar(new FakeCalendar(recorder, {}), guard());
    await expect(
      adapter.createEvent({
        memberRefs: ["dhavals+mentor@wekancode.com", "someone.real@wekancode.com"],
        start: "2026-09-21T09:00:00.000Z",
        end: "2026-09-21T09:45:00.000Z",
        title: "Mentoring",
        description: "",
        withConference: true,
        withTranscription: false,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/someone\.real@wekancode\.com/);
    expect(recorder.calls).toHaveLength(0);
  });

  it("guards free/busy too — it is still their data", async () => {
    const recorder = new Recorder();
    const adapter = guardCalendar(new FakeCalendar(recorder, {}), guard());
    await expect(
      adapter.freeBusy({
        memberRefs: ["someone.real@wekancode.com"],
        window: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" },
      }),
    ).rejects.toBeInstanceOf(SandboxRefusal);
  });

  it("sees through an email: marker and matches case-insensitively", async () => {
    const recorder = new Recorder();
    const adapter = guardDm(new FakeDm(recorder), guard());
    // `PairContext.memberRef` falls back to this shape when there is no
    // verified chat link, and it is still a person.
    await expect(
      adapter.send({
        memberRef: "email:DHAVALS+MENTOR@wekancode.com",
        body: "hi",
        idempotencyKey: "k",
      }),
    ).resolves.toBeDefined();
  });

  it("leaves slots that do not address a person alone", () => {
    const recorder = new Recorder();
    const transcript = guardAdapter(
      { slot: "transcript", id: "x", probe: async () => ({}) } as never,
      guard(),
    );
    expect(transcript.slot).toBe("transcript");
    // And still wraps the three that do.
    expect(guardAdapter(new FakeDm(recorder), guard()).slot).toBe("dm");
  });
});
