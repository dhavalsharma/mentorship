import { describe, expect, it } from "vitest";
import {
  SlackConversationAdapter,
  SlackWebApiModalOpener,
} from "@mentorship/integrations";
import { openReplay, warnOnStaleFixtures } from "./vendor-replay.js";

/**
 * `SlackConversationAdapter` against the recorded Slack Web API
 * (`tests/fixtures/vendor/slack`, tier 4). Each kind of post — plain,
 * proposal, confirmation — is its own `chat.postMessage` fixture variant, so a
 * new top-level field on any one of them fails as drift rather than passing
 * against a stub that accepts anything.
 */

warnOnStaleFixtures("slack-conversation.test.ts");

const THREAD = { adapterId: "slack", channelId: "C0EXAMPLE01", threadId: null };

describe("SlackConversationAdapter", () => {
  it("opens the pair's group DM and reads the channel id off the recorded response", async () => {
    const replay = openReplay();
    const thread = await new SlackConversationAdapter(replay.slack()).ensureThread({
      pairingId: "p1",
      memberRefs: ["U-SAM", "U-PRIYA"],
      title: "Priya & Sam",
    });

    const recorded = replay.fixture("conversations.open").response!["channel"] as { id: string };
    expect(thread).toEqual({ adapterId: "slack", channelId: recorded.id, threadId: null });
    expect(replay.calls[0]).toMatchObject({
      call: "conversations.open",
      body: { users: "U-SAM,U-PRIYA" },
    });
  });

  it("throws when conversations.open answers without a channel", async () => {
    const replay = openReplay().on("conversations.open", ({ response }) => {
      const { channel: _dropped, ...rest } = response;
      return rest;
    });
    await expect(
      new SlackConversationAdapter(replay.slack()).ensureThread({
        pairingId: "p1",
        memberRefs: ["U-SAM"],
        title: "t",
      }),
    ).rejects.toThrow(/no channel/);
  });

  it("posts a proposal as the agreement_proposed variant and returns its ts", async () => {
    const replay = openReplay();
    const result = await new SlackConversationAdapter(replay.slack()).postProposal({
      thread: THREAD,
      agreementId: "agr_1",
      options: [
        {
          optionId: "opt_1",
          startsAt: "2026-09-24T09:00:00.000Z",
          endsAt: "2026-09-24T09:45:00.000Z",
          label: "Thu 24 Sep, 09:00 UTC",
        },
      ],
      body: "Two times that work for you both:",
      idempotencyKey: "k",
    });

    const fixture = replay.fixture("chat.postMessage", "agreement_proposed");
    expect(replay.calls[0]!.fixture).toBe(fixture);
    expect(result).toEqual({ messageRef: fixture.response!["ts"] });
  });

  it("posts a confirmation as the extraction_pending variant", async () => {
    const replay = openReplay();
    const result = await new SlackConversationAdapter(replay.slack()).postConfirmation({
      thread: THREAD,
      extractionId: "ext_1",
      docUrl: "https://docs.google.com/document/d/DOC_ID/edit",
      body: "Here is what I captured.",
      idempotencyKey: "k",
    });

    const fixture = replay.fixture("chat.postMessage", "extraction_pending");
    expect(replay.calls[0]!.fixture).toBe(fixture);
    expect(result).toEqual({ messageRef: fixture.response!["ts"] });
  });

  it("posts a plain message with no blocks", async () => {
    const replay = openReplay();
    await new SlackConversationAdapter(replay.slack()).postMessage({
      thread: THREAD,
      body: "Sam picked Tuesday 09:00. Waiting on Priya.",
      idempotencyKey: "k",
    });
    // `thread_ts: undefined` never reaches the wire, which is what lets the
    // plain fixture (recorded without it) serve this call.
    expect(replay.calls[0]!.body).toEqual({
      channel: "C0EXAMPLE01",
      text: "Sam picked Tuesday 09:00. Waiting on Priya.",
    });
  });

  it("probes with auth.test", async () => {
    const replay = openReplay();
    const caps = await new SlackConversationAdapter(replay.slack()).probe();
    expect(replay.calls[0]!.call).toBe("auth.test");
    expect(caps.threadedConversation).toBe(true);
    expect(caps.interactiveApproval).toBe(true);
  });
});

describe("SlackWebApiModalOpener", () => {
  it("opens the counter modal through views.open with only the recorded fields", async () => {
    const replay = openReplay();
    await new SlackWebApiModalOpener(replay.slack()).openCounterModal({
      triggerId: "1234.5678.abc",
      agreementId: "agr_1",
    });
    expect(replay.calls[0]).toMatchObject({
      call: "views.open",
      body: { trigger_id: "1234.5678.abc" },
    });
  });
});
