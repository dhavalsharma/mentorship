import type { AdapterCapabilities, DmAdapter } from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";
import type { SlackTransport } from "./conversation.js";

/**
 * Slack direct-message adapter — reminders and feedback, privately (invariant
 * 13: this must never fall back to the joint thread).
 *
 * STATUS: the API shapes are real; this has not been run against a live
 * workspace. Same transport as the conversation adapter; a separate class
 * because a 1:1 DM needs none of the thread/button machinery a proposal does.
 */
export class SlackDmAdapter implements DmAdapter {
  readonly slot = "dm" as const;
  readonly id = "slack";

  constructor(private readonly call: SlackTransport) {}

  async probe(): Promise<AdapterCapabilities> {
    await this.call("auth.test", {});
    return AdapterCapabilitiesSchema.parse({ identityMapping: "verified" });
  }

  async send(input: {
    memberRef: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }> {
    // Slack accepts a user id directly as `channel` and opens the IM itself —
    // unlike the per-pair group DM, a 1:1 needs no `conversations.open` first.
    const res = await this.call("chat.postMessage", {
      channel: input.memberRef,
      text: input.body,
    });
    return { messageRef: String(res["ts"]) };
  }
}

/**
 * OPERATIONAL NOTE — unlike the calendar adapter's event id, there is no
 * server-side idempotency key here: `chat.postMessage` does not dedupe on a
 * client-supplied token, so a retried `dm` effect sent straight to Slack would
 * double-send. The engine's completed-effect ledger (invariant 6) is the
 * actual guard for that case; this adapter has no second one of its own the
 * way `FakeDm` does for tests.
 */
