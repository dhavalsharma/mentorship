import { describe, expect, it } from "vitest";
import { SlackDmAdapter } from "@mentorship/integrations";
import { openReplay, warnOnStaleFixtures } from "./vendor-replay.js";

/**
 * Replays `tests/fixtures/vendor/slack` (tier 4). The replay refuses any body
 * field the recorded `chat.postMessage` never carried, so "a 1:1 DM is just
 * `channel` + `text`" is checked against the fixture, not only asserted.
 */

warnOnStaleFixtures("slack-dm.test.ts");

describe("SlackDmAdapter", () => {
  it("posts straight to the user id, opening no separate IM channel", async () => {
    const replay = openReplay();
    const adapter = new SlackDmAdapter(replay.slack());

    const result = await adapter.send({
      memberRef: "U-ARJUN",
      body: "Heads up: your session is at 9am.",
      idempotencyKey: "saga:1:remind:0",
    });

    expect(result).toEqual({
      messageRef: replay.fixture("chat.postMessage").response!["ts"],
    });
    expect(replay.calls.map(({ call, body }) => ({ call, body }))).toEqual([
      {
        call: "chat.postMessage",
        body: { channel: "U-ARJUN", text: "Heads up: your session is at 9am." },
      },
    ]);
  });

  it("probes with auth.test and reports a verified identity mapping", async () => {
    const replay = openReplay();
    const adapter = new SlackDmAdapter(replay.slack());
    const caps = await adapter.probe();
    expect(replay.calls[0]).toMatchObject({ call: "auth.test", body: {} });
    expect(caps.identityMapping).toBe("verified");
    // A 1:1 DM has no thread and no buttons — unlike the conversation adapter.
    expect(caps.threadedConversation).toBe(false);
    expect(caps.interactiveApproval).toBe(false);
  });
});
