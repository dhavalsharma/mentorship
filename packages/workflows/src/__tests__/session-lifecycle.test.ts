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
  opts: BootstrapOptions & { roster?: string; playbookUrl?: string } = {},
): Promise<Ctx> {
  const { roster, playbookUrl, ...bootstrapOpts } = opts;
  const warnings: string[] = [];
  const h = bootstrap({
    busy: BUSY,
    onWarn: (m) => warnings.push(m),
    ...bootstrapOpts,
  });
  if (playbookUrl !== undefined) h.world.playbookUrl = playbookUrl;
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

  it("asks for the verdict on buttons rather than inviting a typed reply", async () => {
    const ctx = await setup({ transcription: "none" });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);
    await ctx.h.world.submitNotes(ctx.pairingId, "Arjun: I'll review it.");
    await ctx.h.dispatcher.settle();

    const state = (await stateOf(ctx.h)) as unknown as {
      name: string;
      extractionId: string;
      docUrl: string;
    };
    expect(state.name).toBe("confirming");

    // The prompt carries the extraction it is asking about, which is what the
    // button values are built from — without it a click could not be tied back
    // to anything, and the only remaining way to read a verdict would be prose.
    const [prompt] = ctx.h.recorder.of("thread.confirmation");
    expect(prompt!.detail["extractionId"]).toBe(state.extractionId);
    expect(prompt!.detail["docUrl"]).toBe(state.docUrl);
  });

  it("binds the pair's channel so an inbound message can be traced back to them", async () => {
    const ctx = await setup();
    const [created] = ctx.h.recorder.of("thread.created");
    const channelId = `C-${ctx.pairingId}`;
    expect(created).toBeDefined();
    expect(ctx.h.world.resolvePairingByChannel(channelId)).toMatchObject({
      pairingId: ctx.pairingId,
    });
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

  it("routes a safeguarding flag straight to the named contact, never through render/confirm", async () => {
    const ctx = await setup({
      transcription: "none",
      policy: { safeguarding: { contactMemberRef: "U-ADMIN" } },
      llm: new DeterministicProvider({
        scripted: [
          {
            when: "BEGIN SESSION RECORD",
            value: {
              summary: ["A disclosure was made."],
              actionItems: [],
              goalProgress: [],
              blockers: [],
              sentimentBand: "strained",
              riskFlags: ["safeguarding"],
              nextSessionPrep: [],
            },
          },
        ],
      }),
    });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);

    await ctx.h.world.submitNotes(
      ctx.pairingId,
      "Priya: something happened I need to report.",
    );
    await ctx.h.dispatcher.settle();

    // Invariant 16: no queue, no batching, no nudge, and — critically — never
    // the render/confirm flow, which would post into the pair's own thread.
    expect(await stateOf(ctx.h)).toMatchObject({ name: "cooling" });
    expect(ctx.h.recorder.of("document.rendered")).toHaveLength(0);
    expect(ctx.h.recorder.of("thread.confirmation")).toHaveLength(0);

    const alert = ctx.h.recorder.of("dm.sent").find((e) => e.detail["to"] === "U-ADMIN");
    expect(alert).toBeDefined();
    expect(String(alert!.detail["body"])).toContain("Review immediately");

    expect(
      ctx.h.log.all().filter((e) => e.name === "safeguarding.flagged"),
    ).toHaveLength(1);
  });

  it("warns loudly instead of silently dropping a safeguarding flag with no contact configured", async () => {
    const ctx = await setup({
      transcription: "none",
      llm: new DeterministicProvider({
        scripted: [
          {
            when: "BEGIN SESSION RECORD",
            value: {
              summary: ["A disclosure was made."],
              actionItems: [],
              goalProgress: [],
              blockers: [],
              sentimentBand: "strained",
              riskFlags: ["safeguarding"],
              nextSessionPrep: [],
            },
          },
        ],
      }),
    });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h);
    await advanceToNextTimer(ctx.h);

    await ctx.h.world.submitNotes(
      ctx.pairingId,
      "Priya: something happened I need to report.",
    );
    await ctx.h.dispatcher.settle();

    expect(
      ctx.h.recorder.of("dm.sent").some((e) => /Review immediately/.test(String(e.detail["body"]))),
    ).toBe(false);
    expect(
      ctx.warnings.some((w) => /safeguarding flagged with no contact configured/.test(w)),
    ).toBe(true);
    expect(
      ctx.h.log.all().filter((e) => e.name === "safeguarding.flagged"),
    ).toHaveLength(1);
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

describe("the shared document's name", () => {
  async function firstRenderedTitle(ctx: Ctx): Promise<string> {
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    await advanceToNextTimer(ctx.h); // session ends, transcript found, doc rendered
    return String(ctx.h.recorder.of("document.rendered")[0]!.detail["title"]);
  }

  it("renders the previously hardcoded title by default", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    expect(await firstRenderedTitle(ctx)).toBe("Mentoring — Arjun & Priya — session notes");
  });

  it("substitutes participant names from a program's own template", async () => {
    const ctx = await setup({
      transcriptAvailableAfter: 1,
      policy: {
        document: { namingTemplate: "{{menteeName}} x {{mentorName}} · log" },
      },
    });
    expect(await firstRenderedTitle(ctx)).toBe("Priya x Arjun · log");
  });

  it("leaves an unknown placeholder visible rather than blanking it", async () => {
    const ctx = await setup({
      transcriptAvailableAfter: 1,
      policy: { document: { namingTemplate: "{{pairTitle}} {{typo}}" } },
    });
    expect(await firstRenderedTitle(ctx)).toBe("Mentoring — Arjun & Priya {{typo}}");
  });
});

describe("the shared document's access", () => {
  /**
   * The link the saga posts is worth nothing if the pair cannot open what it
   * points at, and no other step grants them access — the folder's own sharing
   * is whatever an admin happened to set.
   */
  it("renders with both participants as collaborators", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    await advanceToNextTimer(ctx.h); // session ends, transcript found, doc rendered

    const rendered = ctx.h.recorder.of("document.rendered");
    expect(rendered.length).toBeGreaterThan(0);
    for (const call of rendered) {
      expect(call.detail["collaborators"]).toEqual(["arjun@x.com", "priya@x.com"]);
    }
  });
});

describe("the org's playbook link", () => {
  const PLAYBOOK = "https://docs.google.com/document/d/GUIDE_1/edit";

  /**
   * Proposal, shared reminder and the private feedback question, driven all the
   * way through one session so all three are real effect output rather than
   * hand-built strings.
   */
  async function messagesFor(playbookUrl?: string): Promise<{
    proposal: string;
    reminder: string;
    headsUpDms: string[];
    feedback: string[];
  }> {
    const ctx = await setup({
      transcriptAvailableAfter: 1,
      ...(playbookUrl === undefined ? {} : { playbookUrl }),
    });
    const proposal = String(ctx.h.recorder.of("thread.proposal")[0]!.detail["body"]);

    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    const reminder = String(
      ctx.h.recorder
        .of("thread.message")
        .map((c) => String(c.detail["body"]))
        .find((b) => b.startsWith("Reminder:")),
    );
    const headsUpDms = ctx.h.recorder
      .of("dm.sent")
      .map((c) => String(c.detail["body"]))
      .filter((b) => b.startsWith("Heads up:"));

    await advanceToNextTimer(ctx.h); // session ends, transcript found
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    for (const p of agreement.participantIds) {
      await ctx.h.world.confirmExtraction(ctx.pairingId, p);
    }
    await ctx.h.dispatcher.settle();
    const feedback = ctx.h.recorder
      .of("dm.sent")
      .map((c) => String(c.detail["body"]))
      .filter((b) => b.startsWith("Was that session useful?"));

    return { proposal, reminder, headsUpDms, feedback };
  }

  it("appends the link to the proposal, the reminder and the feedback request", async () => {
    const plain = await messagesFor();
    const linked = await messagesFor(PLAYBOOK);
    const suffix = `\n\nProgram playbook: ${PLAYBOOK}`;

    expect(linked.proposal).toBe(`${plain.proposal}${suffix}`);
    expect(linked.reminder).toBe(`${plain.reminder}${suffix}`);
    expect(linked.feedback).toHaveLength(2);
    for (const [i, body] of linked.feedback.entries()) {
      expect(body).toBe(`${plain.feedback[i]}${suffix}`);
    }
  });

  it("leaves the individual heads-up DMs terse", async () => {
    const linked = await messagesFor(PLAYBOOK);
    expect(linked.headsUpDms).toHaveLength(2);
    for (const body of linked.headsUpDms) expect(body).not.toContain(PLAYBOOK);
  });

  // The regression guard: an org with no guideline doc must get byte-identical
  // text to what it got before the link existed — no trailing blank line, no
  // "playbook: null". These literals are the pre-change wording — plus the
  // session-length line, which belongs to pair preferences (on by default),
  // not to the playbook, and is pinned here so it cannot drift either.
  it("changes nothing at all when no playbook is configured", async () => {
    const plain = await messagesFor();

    expect(plain.proposal).toBe(
      [
        "Time for your fortnightly session, Arjun and Priya.",
        "",
        "Pick one, or suggest another:",
        "  1. Mon 14 Sept 10:30 (UTC+05:30)",
        "  2. Tue 15 Sept 09:00 (UTC+05:30)",
        "  3. Wed 16 Sept 09:00 (UTC+05:30)",
        "",
        "Each slot is 45 minutes. Change length or rhythm with Session preferences.",
      ].join("\n"),
    );
    expect(plain.reminder).toBe(
      "Reminder: your session is coming up — Mon, 14 Sep 2026 05:00:00 GMT.",
    );
    for (const body of plain.feedback) {
      expect(body).toBe("Was that session useful? 1–5, and anything you'd change.");
    }
  });
});

/**
 * What the pair can see while they are deciding. Before this, one person
 * accepting produced no message at all: the thread went silent until either a
 * booking appeared or the window closed, which reads as the bot ignoring them.
 */
describe("pick-status feedback", () => {
  const messagesOf = (ctx: Ctx): string[] =>
    ctx.h.recorder.of("thread.message").map((c) => String(c.detail["body"]));

  it("announces the first pick and who it is waiting on, without booking", async () => {
    const ctx = await setup();
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    const option = agreement.options[0]!;
    await ctx.h.world.respond(
      agreement.id,
      agreement.participantIds[0]!,
      "accept",
      option.optionId,
    );
    await ctx.h.dispatcher.settle();

    expect(messagesOf(ctx)).toContain(
      `Arjun picked ${option.label}. Waiting on Priya.`,
    );
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });
    expect(ctx.h.recorder.of("calendar.created")).toHaveLength(0);
  });

  it("books cleanly when the second person picks the same slot", async () => {
    const ctx = await setup();
    await bothAccept(ctx);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "armed" });
    expect(ctx.h.recorder.of("calendar.created")).toHaveLength(1);
    // Both clicks land before the saga steps, so by the time it looks there is
    // nobody left to wait on — the pick-status line is for a *pending*
    // agreement and must not appear on an already-unanimous one.
    expect(messagesOf(ctx).filter((b) => b.includes("Waiting on"))).toEqual([]);
    expect(messagesOf(ctx).some((b) => b.startsWith("Booked — "))).toBe(true);
  });

  it("names both picks before re-proposing when they choose different slots", async () => {
    const ctx = await setup();
    const first = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    const [arjunPick, priyaPick] = [first.options[0]!, first.options[1]!];
    await ctx.h.world.respond(
      first.id,
      first.participantIds[0]!,
      "accept",
      arjunPick.optionId,
    );
    await ctx.h.dispatcher.settle();
    await ctx.h.world.respond(
      first.id,
      first.participantIds[1]!,
      "accept",
      priyaPick.optionId,
    );
    await ctx.h.dispatcher.settle();

    const proposals = ctx.h.recorder.of("thread.proposal");
    expect(proposals).toHaveLength(2);
    const body = String(proposals[1]!.detail["body"]);
    expect(body).toContain(
      `Arjun picked ${arjunPick.label}, Priya picked ${priyaPick.label} — let's find one that works for both:`,
    );

    // Both of the contested slots are re-offered, leading the list.
    const second = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    expect(second.id).not.toBe(first.id);
    expect(second.options.slice(0, 2).map((o) => o.startsAt)).toEqual([
      arjunPick.startsAt,
      priyaPick.startsAt,
    ]);
    expect(ctx.h.recorder.of("calendar.created")).toHaveLength(0);
  });
});

/**
 * The confirming-state counterpart to "pick-status feedback" above. Before
 * this, Confirm/Edit posted a bare 200 to Slack — nothing appeared in the
 * thread until *both* participants had responded, which reads identically to
 * the click having been dropped.
 */
describe("confirmation-status feedback", () => {
  const messagesOf = (ctx: Ctx): string[] =>
    ctx.h.recorder.of("thread.message").map((c) => String(c.detail["body"]));

  async function toConfirming(ctx: Ctx): Promise<void> {
    await bothAccept(ctx, 1);
    await advanceToNextTimer(ctx.h); // reminder
    await advanceToNextTimer(ctx.h); // session ends, transcript found
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });
  }

  it("announces the first confirmation and who it is waiting on, before feedback starts", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await toConfirming(ctx);
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;

    await ctx.h.world.confirmExtraction(ctx.pairingId, agreement.participantIds[0]!);
    await ctx.h.dispatcher.settle();

    expect(messagesOf(ctx)).toContain(
      "Arjun confirmed the write-up. Waiting on Priya.",
    );
    expect(await stateOf(ctx.h)).toMatchObject({ name: "confirming" });
    expect(ctx.h.recorder.of("dm.sent").filter((c) =>
      String(c.detail["body"]).startsWith("Was that session useful?"),
    )).toHaveLength(0);
  });

  it("words an edit differently from a plain confirm", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await toConfirming(ctx);
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;

    await ctx.h.world.confirmExtraction(
      ctx.pairingId,
      agreement.participantIds[1]!,
      true,
    );
    await ctx.h.dispatcher.settle();

    expect(messagesOf(ctx)).toContain(
      "Priya is editing the write-up. Waiting on Arjun.",
    );
  });

  it("posts no extra acknowledgment once both have responded", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await toConfirming(ctx);
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;

    for (const p of agreement.participantIds) {
      await ctx.h.world.confirmExtraction(ctx.pairingId, p);
    }
    await ctx.h.dispatcher.settle();

    expect(await stateOf(ctx.h)).toMatchObject({ name: "feedback" });
    // Exactly the one acknowledgment from the first response — the second,
    // completing response must not produce a duplicate or a second line.
    expect(
      messagesOf(ctx).filter((b) => b.includes("the write-up")),
    ).toHaveLength(1);
  });
});

/**
 * A pair choosing its own session length and rhythm. The choice lands on the
 * pair-level cadence override, so the saga follows it simply by reading
 * `pair.cadence` — the one thing it has to do actively is re-time a cooling
 * pair, whose wake-up was computed from the old rhythm.
 */
describe("pair-chosen length and rhythm", () => {
  async function toCooling(ctx: Ctx): Promise<void> {
    await bothAccept(ctx);
    await advanceToNextTimer(ctx.h); // reminder
    await advanceToNextTimer(ctx.h); // session ends, transcript found
    const agreement = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    for (const p of agreement.participantIds) {
      await ctx.h.world.confirmExtraction(ctx.pairingId, p);
    }
    await ctx.h.dispatcher.settle();
    for (const p of agreement.participantIds) {
      await ctx.h.world.submitFeedback(ctx.pairingId, p, 5);
    }
    await ctx.h.dispatcher.settle();
    expect(await stateOf(ctx.h)).toMatchObject({ name: "cooling" });
  }

  const minutesOf = (o: { startsAt: string; endsAt: string }) =>
    (Date.parse(o.endsAt) - Date.parse(o.startsAt)) / 60_000;

  it("offers the Session preferences control on the proposal", async () => {
    const ctx = await setup();
    const [proposal] = ctx.h.recorder.of("thread.proposal");
    expect(proposal!.detail["preferencesPairingId"]).toBe(ctx.pairingId);
  });

  it("offers neither the control nor the length line when the program sets them", async () => {
    const ctx = await setup({ policy: { pairPreferences: { enabled: false } } });
    const [proposal] = ctx.h.recorder.of("thread.proposal");
    expect(proposal!.detail["preferencesPairingId"]).toBeUndefined();
    expect(String(proposal!.detail["body"])).not.toContain("Session preferences");
  });

  it("neither names nor offers the control when proposals degrade to plain DMs", async () => {
    const ctx = await setup({ omitSlots: ["conversation"] });
    expect(ctx.h.recorder.of("thread.proposal")).toHaveLength(0);
    const dms = ctx.h.recorder.of("dm.sent").map((c) => String(c.detail["body"]));
    expect(dms.some((b) => b.startsWith("Time for your"))).toBe(true);
    for (const body of dms) expect(body).not.toContain("Session preferences");
  });

  it("books the next session at the length the pair chose", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    expect(minutesOf(ctx.h.world.latestAgreementFor(ctx.pairingId)!.options[0]!)).toBe(45);
    await toCooling(ctx);

    const [mentor] = ctx.h.world.latestAgreementFor(ctx.pairingId)!.participantIds;
    await ctx.h.world.updatePairPreferences({
      pairingId: ctx.pairingId,
      participantId: mentor!,
      preferences: { sessionMinutes: 30 },
    });
    await ctx.h.dispatcher.settle();
    await advanceToNextTimer(ctx.h);

    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });
    const next = ctx.h.world.latestAgreementFor(ctx.pairingId)!;
    for (const option of next.options) expect(minutesOf(option)).toBe(30);
    const proposals = ctx.h.recorder.of("thread.proposal");
    expect(String(proposals.at(-1)!.detail["body"])).toContain(
      "Each slot is 30 minutes.",
    );
  });

  it("re-times a cooling pair to its new rhythm and tells the thread who changed it", async () => {
    const ctx = await setup({ transcriptAvailableAfter: 1 });
    await toCooling(ctx);
    const fortnightlyWake = await ctx.h.engine.nextTimeout();

    const [mentor] = ctx.h.world.latestAgreementFor(ctx.pairingId)!.participantIds;
    await ctx.h.world.updatePairPreferences({
      pairingId: ctx.pairingId,
      participantId: mentor!,
      preferences: { everyDays: 7 },
    });
    await ctx.h.dispatcher.settle();

    expect(await stateOf(ctx.h)).toMatchObject({ name: "cooling" });
    const weeklyWake = await ctx.h.engine.nextTimeout();
    // Same last session, seven fewer days to wait.
    expect(Date.parse(fortnightlyWake!) - Date.parse(weeklyWake!)).toBe(
      7 * 24 * 60 * 60_000,
    );
    const messages = ctx.h.recorder
      .of("thread.message")
      .map((c) => String(c.detail["body"]));
    expect(messages.at(-1)).toMatch(
      /^Arjun updated your sessions: 45-minute sessions, every week\. Next proposal around /,
    );

    await advanceToNextTimer(ctx.h);
    expect(await stateOf(ctx.h)).toMatchObject({ name: "proposing" });
    expect(String(ctx.h.recorder.of("thread.proposal").at(-1)!.detail["body"])).toContain(
      "Time for your weekly session",
    );
  });

  it("refuses a change from someone who is not in the pair", async () => {
    const ctx = await setup();
    expect(
      await ctx.h.world.updatePairPreferences({
        pairingId: ctx.pairingId,
        participantId: "prt_stranger",
        preferences: { everyDays: 7 },
      }),
    ).toEqual({ ok: false, reason: "not_member" });
    expect(
      ctx.h.log.all().filter((e) => e.name === "pair.preferences_updated"),
    ).toHaveLength(0);
  });
});
