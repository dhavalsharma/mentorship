import { describe, expect, it } from "vitest";
import { SlackDmAdapter, type SlackTransport } from "@mentorship/integrations";

describe("SlackDmAdapter", () => {
  function transport(
    responses: Record<string, Record<string, unknown>> = {},
  ): SlackTransport & { calls: { method: string; body: Record<string, unknown> }[] } {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const call: SlackTransport = async (method, body) => {
      calls.push({ method, body });
      return responses[method] ?? { ok: true };
    };
    return Object.assign(call, { calls });
  }

  it("posts straight to the user id, opening no separate IM channel", async () => {
    const call = transport({ "chat.postMessage": { ts: "1726400000.000100" } });
    const adapter = new SlackDmAdapter(call);

    const result = await adapter.send({
      memberRef: "U-ARJUN",
      body: "Heads up: your session is at 9am.",
      idempotencyKey: "saga:1:remind:0",
    });

    expect(result).toEqual({ messageRef: "1726400000.000100" });
    expect(call.calls).toEqual([
      {
        method: "chat.postMessage",
        body: { channel: "U-ARJUN", text: "Heads up: your session is at 9am." },
      },
    ]);
  });

  it("probes with auth.test and reports a verified identity mapping", async () => {
    const call = transport();
    const adapter = new SlackDmAdapter(call);
    const caps = await adapter.probe();
    expect(call.calls[0]).toEqual({ method: "auth.test", body: {} });
    expect(caps.identityMapping).toBe("verified");
    // A 1:1 DM has no thread and no buttons — unlike the conversation adapter.
    expect(caps.threadedConversation).toBe(false);
    expect(caps.interactiveApproval).toBe(false);
  });
});
