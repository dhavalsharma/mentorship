import { beforeEach, describe, expect, it } from "vitest";
import { DeterministicProvider, NullAiRunSink } from "@mentorship/ai";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import {
  advanceToNextTimer,
  bootstrap,
  type BootstrapOptions,
  type Harness,
} from "@mentorship/testkit";

/**
 * The whole planner flow, driven with fake adapters and a controllable clock.
 * Every one of these runs in milliseconds, which is the point of keeping the
 * inferred steps down to two.
 */

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun@x.com,Arjun,priya@x.com,Priya,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

const BUSY = {
  "arjun@x.com": [
    { start: "2026-09-14T03:30:00.000Z", end: "2026-09-14T05:00:00.000Z" },
  ],
};

interface Ctx {
  h: Harness;
  pairingId: string;
  warnings: string[];
}

async function setup(
  opts: BootstrapOptions & { roster?: string } = {},
): Promise<Ctx> {
  const { roster, ...bootstrapOpts } = opts;
  const warnings: string[] = [];
  const h = bootstrap({
    busy: BUSY,
    onWarn: (m) => warnings.push(m),
    ...bootstrapOpts,
  });
  const plan = planRosterImport(roster ?? ONE_PAIR, {
    policy: h.policy,
    defaultTzOffsetMinutes: 330,
  });
  const committed = await commitRosterImport(plan, h.world, {
    importedPairsStart: "active",
  });
  await h.dispatcher.settle();
  return { h, pairingId: committed.created[0]!.pairingId, warnings };
}

const stateOf = async (h: Harness) => {
  const [instance] = await h.engine.instances();
  return instance!.state as { name: string; mode?: string; reason?: string };
};

const statusOf = async (h: Harness) => {
  const [instance] = await h.engine.instances();
  return instance!.status;
};

async function bothAccept(ctx: Ctx, optionIndex = 0): Promise<void> {
  const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
  const option = agreement.options[optionIndex]!;
  for (const participantId of agreement.participantIds) {
    await ctx.h.world.respond(
      agreement.id,
      participantId,
      "accept",
      option.optionId,
    );
  }
  await ctx.h.dispatcher.settle();
}

describe("an imported pair enters the lifecycle identically to a matched one", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("starts from pair.activated and proposes immediately", async () => {
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });
    const proposals = ctx.h.recorder.of("thread.proposal");
    expect(proposals).toHaveLength(1);
    expect((proposals[0]!.detail["options"] as string[]).length).toBe(3);
  });

  it("opens a private thread for exactly the two participants", async () => {
    const [created] = ctx.h.recorder.of("thread.created");
    expect(created!.detail["members"]).toEqual(["U-ARJUN", "U-PRIYA"]);
  });

  it("proposes around the mentor's existing commitment", async () => {
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    const clashes = agreement.options.filter(
      (o) =>
        o.startsAt >= BUSY["arjun@x.com"]![0]!.start &&
        o.startsAt < BUSY["arjun@x.com"]![0]!.end,
    );
    expect(clashes).toEqual([]);
  });
});

describe("the happy path", () => {
  it("books, reminds, extracts, confirms, collects feedback and loops", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await bothAccept(ctx, 1);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "armed" });
    expect(ctx.h.recorder.of("calendar.created")).toHaveLength(1);

    await advanceToNextTimer(ctx.h); // reminder
    expect(ctx.h.recorder.of("dm.sent")).toHaveLength(2);

    await advanceToNextTimer(ctx.h); // session ends, transcript found
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });
    expect(ctx.h.recorder.of("document.rendered")).toHaveLength(1);

    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    for (const p of agreement.participantIds) {
      await ctx.h.world.confirmExtraction(ctx.pairingId, p);
    }
    await ctx.h.dispatcher.settle();
    expect(await stateOf(ctx.h)).toMatchObject({ name: "feedback" });

    for (const p of agreement.participantIds) {
      await ctx.h.world.submitFeedback(ctx.pairingId, p, 5);
    }
    await ctx.h.dispatcher.settle();
    expect(await stateOf(ctx.h)).toMatchObject({ name: "cooling" });

    // The fortnight elapsing is not a separate check — it is cooling expiring.
    await advanceToNextTimer(ctx.h);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });
    expect(ctx.h.recorder.of("thread.proposal")).toHaveLength(2);
    expect(
      ctx.h.log.all().filter((e) => e.name === "pair.cadence_deficit"),
    ).toHaveLength(1);
  });

  it("asks for feedback privately, never in the joint thread", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    for (const p of agreement.participantIds) {
      await ctx.h.world.confirmExtraction(ctx.pairingId, p);
    }
    await ctx.h.dispatcher.settle();

    const question = "Was that session useful?";
    expect(
      ctx.h.recorder
        .of("dm.sent")
        .filter((c) => String(c.detail["body"]).includes(question)),
    ).toHaveLength(2);
    expect(
      ctx.h.recorder
        .of("thread.message")
        .filter((c) => String(c.detail["body"]).includes(question)),
    ).toHaveLength(0);
  });

  it("books exactly one invite for one agreement", async () => {
    const ctx = await setup();
    await bothAccept(ctx);
    // Re-delivering the acceptance must not produce a second calendar event.
    await bothAccept(ctx);
    expect(ctx.h.recorder.of("calendar.created")).toHaveLength(1);
  });
});

describe("agreement outcomes", () => {
  it("re-proposes with the counter leading the options", async () => {
    const ctx = await setup();
    const first = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    const counter = {
      optionId: "opt_counter",
      startsAt: "2026-09-17T05:00:00.000Z",
      endsAt: "2026-09-17T05:45:00.000Z",
      label: "Thu 17 Sept 10:30",
    };
    await ctx.h.world.respond(
      first.id,
      first.participantIds[1]!,
      "counter",
      undefined,
      counter,
    );
    await ctx.h.dispatcher.settle();

    const second = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    expect(second.id).not.toBe(first.id);
    expect(second.round).toBe(2);
    expect(second.options[0]!.startsAt).toBe(counter.startsAt);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing", round: 2 });
  });

  it("pauses and escalates when a party declines", async () => {
    const ctx = await setup();
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    await ctx.h.world.respond(
      agreement.id,
      agreement.participantIds[0]!,
      "decline",
    );
    await ctx.h.dispatcher.settle();

    expect(await stateOf(ctx.h)).toMatchObject({
      name: "paused",
      reason: "declined",
    });
    expect(await statusOf(ctx.h)).toBe("done");
    expect(
      ctx.h.log.all().filter((e) => e.name === "saga.escalated"),
    ).toHaveLength(1);
  });

  it("nudges once on silence, then escalates — never a third attempt", async () => {
    const ctx = await setup();

    await advanceToNextTimer(ctx.h); // response window closes
    const nudges = ctx.h.recorder
      .of("thread.message")
      .filter((c) => String(c.detail["body"]).includes("Nudging gently"));
    expect(nudges).toHaveLength(1);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });

    await advanceToNextTimer(ctx.h); // still silent
    expect(await stateOf(ctx.h)).toMatchObject({
      name: "paused",
      reason: "no_response",
    });
    expect(
      ctx.h.recorder
        .of("thread.message")
        .filter((c) => String(c.detail["body"]).includes("Nudging gently")),
    ).toHaveLength(1);
  });

  it("escalates rather than guessing when only one party replies", async () => {
    const ctx = await setup();
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    await ctx.h.world.respond(
      agreement.id,
      agreement.participantIds[0]!,
      "accept",
      agreement.options[0]!.optionId,
    );
    await ctx.h.dispatcher.settle();
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });

    await advanceToNextTimer(ctx.h);
    expect(await stateOf(ctx.h)).toMatchObject({
      name: "paused",
      reason: "one_sided_response",
    });
  });

  it("proceeds on one reply when the program prefers over-scheduling", async () => {
    const ctx = await setup({
      policy: { agreement: { resolution: "proceed_on_one" } },
    });
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    await ctx.h.world.respond(
      agreement.id,
      agreement.participantIds[0]!,
      "accept",
      agreement.options[0]!.optionId,
    );
    await ctx.h.dispatcher.settle();
    await advanceToNextTimer(ctx.h);

    expect(await stateOf(ctx.h)).toMatchObject({ name: "armed" });
    const [created] = ctx.h.recorder.of("calendar.created");
    expect(created).toBeDefined();
  });
});

describe("capability and consent branches", () => {
  it("skips transcript polling entirely when the tenant has no entitlement", async () => {
    const ctx = await setup({ transcription: "none" });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    await advanceToNextTimer(ctx.h); // meeting ends

    expect(await stateOf(ctx.h)).toMatchObject({
      name: "awaiting_artifact",
      mode: "manual_notes",
    });
    expect(ctx.h.recorder.of("transcript.fetch")).toHaveLength(0);
  });

  it("does not enable transcription without consent from both parties", async () => {
    const ctx = await setup({ recordingConsent: false });
    await bothAccept(ctx);
    const [created] = ctx.h.recorder.of("calendar.created");
    expect(created!.detail["transcription"]).toBe(false);

    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);
    expect(await stateOf(ctx.h)).toMatchObject({ mode: "manual_notes" });
  });

  it("backs off across the poll schedule, then asks for notes", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 99 });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    for (let i = 0; i < 6; i++) await advanceToNextTimer(ctx.h);

    const fetches = ctx.h.recorder.of("transcript.fetch");
    expect(fetches.length).toBe(ctx.h.policy.artifact.pollScheduleMinutes.length);
    expect(await stateOf(ctx.h)).toMatchObject({ mode: "manual_notes" });
    expect(
      ctx.h.recorder
        .of("thread.message")
        .filter((c) => String(c.detail["body"]).includes("couldn't find a transcript")),
    ).toHaveLength(1);
  });

  it("records an undocumented session rather than stalling forever", async () => {
    const ctx = await setup({ transcription: "none" });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    await advanceToNextTimer(ctx.h); // meeting ends -> manual notes
    await advanceToNextTimer(ctx.h); // notes window closes

    expect(
      ctx.h.log.all().filter((e) => e.name === "session.undocumented"),
    ).toHaveLength(1);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "cooling" });
  });

  it("accepts typed notes when there is no transcript", async () => {
    const ctx = await setup({ transcription: "none" });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);

    await ctx.h.world.submitNotes(
      ctx.pairingId,
      "Arjun: I'll review the draft by Friday.",
    );
    await ctx.h.dispatcher.settle();
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });
  });

  it("runs the real session-intel primitive when a model is wired in, not the heuristic", async () => {
    const runs = new NullAiRunSink();
    const ctx = await setup({
      transcription: "none",
      llm: new DeterministicProvider({ failWith: new Error("no scripted response for this test") }),
      runs,
    });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);

    await ctx.h.world.submitNotes(
      ctx.pairingId,
      "Arjun: I'll review the draft by Friday.",
    );
    await ctx.h.dispatcher.settle();
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });

    // The model call above always fails, so this is the primitive's own
    // deterministic fallback — not the unrelated `heuristicSessionIntel`
    // stub. The two are distinguishable by shape: the primitive renders a
    // checkbox with a quoted evidence span, the old stub never did.
    const [extracted] = ctx.h.log.all().filter((e) => e.name === "extraction.completed");
    const markdown = String(extracted!.payload["markdown"]);
    expect(markdown).toContain("- [ ] **Arjun**:");
    expect(markdown).toContain("> I'll review the draft by Friday.");

    // And the run was recorded — invariant 20 — even though it degraded.
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.primitive).toBe("session.intel");
    expect(runs.runs[0]!.error).toBeDefined();
  });

  it("falls back to an internal page when no document slot is bound", async () => {
    const ctx = await setup({
      transcriptAvailableAfter: 1,
      omitSlots: ["document"],
    });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);

    const [rendered] = ctx.h.log.all().filter((e) => e.name === "document.rendered");
    expect(rendered!.payload["degraded"]).toBe(true);
    expect(String(rendered!.payload["url"])).toContain("/notes");
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });
  });

  it("never leaks a private message into the joint thread when the dm slot is empty", async () => {
    const ctx = await setup({
      transcriptAvailableAfter: 1,
      omitSlots: ["dm"],
    });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    expect(ctx.h.recorder.of("dm.sent")).toHaveLength(0);
    expect(
      ctx.warnings.some((w) => /private message not sent/.test(w)),
    ).toBe(true);
  });
});

describe("out-of-band changes and terminal conditions", () => {
  it("re-proposes when the invite is deleted from the calendar", async () => {
    const ctx = await setup();
    await bothAccept(ctx);
    const [created] = ctx.h.recorder.of("calendar.created");

    await ctx.h.world.cancelSession(
      ctx.pairingId,
      String(created!.detail["eventId"]),
    );
    await ctx.h.dispatcher.settle();

    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });
    expect(
      ctx.h.recorder
        .of("thread.proposal")
        .filter((c) => String(c.detail["body"]).includes("disappeared")),
    ).toHaveLength(1);
  });

  it("ends the saga when the pairing ends, from any state", async () => {
    const ctx = await setup();
    await bothAccept(ctx);
    await ctx.h.log.emit({
      orgId: ctx.h.world.orgId,
      name: "pair.ended",
      subjectRef: `pairing:${ctx.pairingId}`,
      payload: { reason: "mentee left the company" },
    });
    await ctx.h.dispatcher.settle();
    expect(await statusOf(ctx.h)).toBe("done");
  });

  it("stops after one session for an ad-hoc program with no cadence", async () => {
    const ctx = await setup({
      transcriptAvailableAfter: 1,
      // "as needed" in the cadence column: the pair's agreed frequency
      // overrides the program default.
      roster: ONE_PAIR.replace("fortnightly", "as needed"),
    });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    for (const p of agreement.participantIds) {
      await ctx.h.world.confirmExtraction(ctx.pairingId, p);
    }
    await ctx.h.dispatcher.settle();
    for (const p of agreement.participantIds) {
      await ctx.h.world.submitFeedback(ctx.pairingId, p, 4);
    }
    await ctx.h.dispatcher.settle();

    expect(await stateOf(ctx.h)).toMatchObject({ name: "cooling" });
    expect(await statusOf(ctx.h)).toBe("done");
    expect(await ctx.h.engine.nextTimeout()).toBeNull();
  });

  it("auto-confirms on timeout but marks it unverified", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });

    await advanceToNextTimer(ctx.h); // confirmation window closes

    const confirmed = ctx.h.log
      .all()
      .filter((e) => e.name === "extraction.confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.payload["unverified"]).toBe(true);
    const renders = ctx.h.recorder.of("document.rendered");
    expect(renders.length).toBeGreaterThan(1);
  });
});
