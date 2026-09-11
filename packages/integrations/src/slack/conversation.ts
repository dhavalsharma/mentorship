import type {
  AdapterCapabilities,
  ConversationAdapter,
  ProposalOption,
  ThreadRef,
} from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";

/**
 * Slack conversation adapter.
 *
 * STATUS: the API shapes are real; this has not been run against a live
 * workspace. Supply a transport and a bot token to use it, and read the two
 * operational notes at the bottom before you do.
 *
 * The per-pair thread is a multi-person DM (`conversations.open` with both
 * user ids), which is the right primitive: it is private to the pair and the
 * bot, it survives channel reorganisation, and it needs no channel creation
 * permission.
 */

export type SlackTransport = (
  method: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export function httpSlackTransport(botToken: string): SlackTransport {
  return async (method, body) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (json["ok"] !== true) {
      throw new Error(`slack ${method} failed: ${String(json["error"])}`);
    }
    return json;
  };
}

export class SlackConversationAdapter implements ConversationAdapter {
  readonly slot = "conversation" as const;
  readonly id = "slack";

  constructor(private readonly call: SlackTransport) {}

  async probe(): Promise<AdapterCapabilities> {
    // `auth.test` confirms the token works and the bot is installed; scopes
    // come back on the response headers in current Slack responses.
    await this.call("auth.test", {});
    return AdapterCapabilitiesSchema.parse({
      threadedConversation: true,
      interactiveApproval: true,
      identityMapping: "verified",
    });
  }

  async ensureThread(input: {
    pairingId: string;
    memberRefs: string[];
    title: string;
  }): Promise<ThreadRef> {
    const res = await this.call("conversations.open", {
      users: input.memberRefs.join(","),
    });
    const channel = res["channel"] as { id: string } | undefined;
    if (!channel) throw new Error("slack conversations.open returned no channel");
    return { adapterId: this.id, channelId: channel.id, threadId: null };
  }

  async postProposal(input: {
    thread: ThreadRef;
    agreementId: string;
    options: ProposalOption[];
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }> {
    const res = await this.call("chat.postMessage", {
      channel: input.thread.channelId,
      thread_ts: input.thread.threadId ?? undefined,
      text: input.body,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: input.body } },
        {
          type: "actions",
          // The value carries the agreement and option so the interaction
          // handler never has to parse prose to learn what was agreed.
          elements: [
            ...input.options.map((o, i) => ({
              type: "button",
              text: { type: "plain_text", text: `Option ${i + 1}` },
              action_id: `agree:${input.agreementId}:${o.optionId}`,
              value: JSON.stringify({
                agreementId: input.agreementId,
                optionId: o.optionId,
                kind: "accept",
              }),
            })),
            {
              type: "button",
              text: { type: "plain_text", text: "Suggest another" },
              action_id: `counter:${input.agreementId}`,
              value: JSON.stringify({
                agreementId: input.agreementId,
                kind: "counter",
              }),
            },
          ],
        },
      ],
      metadata: {
        event_type: "agreement_proposed",
        event_payload: { agreement_id: input.agreementId },
      },
    });
    return { messageRef: String(res["ts"]) };
  }

  async postMessage(input: {
    thread: ThreadRef;
    body: string;
    idempotencyKey: string;
  }): Promise<{ messageRef: string }> {
    const res = await this.call("chat.postMessage", {
      channel: input.thread.channelId,
      thread_ts: input.thread.threadId ?? undefined,
      text: input.body,
    });
    return { messageRef: String(res["ts"]) };
  }
}

/**
 * OPERATIONAL NOTES — both of these are things that bite on first deploy.
 *
 * 1. Interactivity has a hard acknowledgement deadline (currently 3 seconds).
 *    The request handler must verify the signature, write an
 *    `agreement.responded` event, return 200, and let the saga advance
 *    asynchronously. Doing the work before responding will time out and Slack
 *    will show the user an error while the action actually succeeded.
 *
 * 2. Verify `x-slack-signature` against the raw request body with your signing
 *    secret, and reject timestamps older than five minutes. An unverified
 *    interaction endpoint lets anyone book meetings for anyone.
 */
