import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleSlackInteraction,
  parseSlackInteractionPayload,
  verifySlackSignature,
  type AgreementResponder,
  type ChatIdentityResolver,
  type SlackInteractionDeps,
} from "@mentorship/integrations";

const SECRET = "shh-its-a-secret";
const NOW = new Date("2026-09-15T04:30:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(rawBody: string, timestamp = TS, secret = SECRET): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return "v0=" + createHmac("sha256", secret).update(base).digest("hex");
}

function acceptBody(overrides: Record<string, unknown> = {}): string {
  const payload = {
    user: { id: "U-ARJUN" },
    actions: [
      {
        action_id: "agree:agr_001:opt_2",
        value: JSON.stringify({
          agreementId: "agr_001",
          optionId: "opt_2",
          kind: "accept",
          ...overrides,
        }),
      },
    ],
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

describe("verifySlackSignature", () => {
  it("accepts a signature computed the way Slack computes it", () => {
    const body = acceptBody();
    expect(
      verifySlackSignature(
        { signingSecret: SECRET, timestamp: TS, rawBody: body, signature: sign(body) },
        NOW,
      ),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const body = acceptBody();
    const bad = sign(body, TS, "wrong-secret");
    expect(
      verifySlackSignature(
        { signingSecret: SECRET, timestamp: TS, rawBody: body, signature: bad },
        NOW,
      ),
    ).toBe(false);
  });

  it("rejects a body that does not match what was signed", () => {
    const body = acceptBody();
    const signature = sign(body);
    const tampered = acceptBody({ optionId: "opt_1" });
    expect(
      verifySlackSignature(
        { signingSecret: SECRET, timestamp: TS, rawBody: tampered, signature },
        NOW,
      ),
    ).toBe(false);
  });

  it("rejects a stale timestamp even with a valid signature", () => {
    const body = acceptBody();
    const staleTs = String(Number(TS) - 6 * 60);
    const signature = sign(body, staleTs);
    expect(
      verifySlackSignature(
        { signingSecret: SECRET, timestamp: staleTs, rawBody: body, signature },
        NOW,
      ),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const body = acceptBody();
    expect(
      verifySlackSignature(
        {
          signingSecret: SECRET,
          timestamp: "not-a-number",
          rawBody: body,
          signature: sign(body, "not-a-number"),
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("parseSlackInteractionPayload", () => {
  it("parses an accept button click", () => {
    expect(parseSlackInteractionPayload(acceptBody())).toEqual({
      slackUserId: "U-ARJUN",
      actionId: "agree:agr_001:opt_2",
      agreementId: "agr_001",
      kind: "accept",
      optionId: "opt_2",
    });
  });

  it("parses a counter ('suggest another') click", () => {
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        user: { id: "U-PRIYA" },
        actions: [
          {
            action_id: "counter:agr_001",
            value: JSON.stringify({ agreementId: "agr_001", kind: "counter" }),
          },
        ],
      }),
    )}`;
    expect(parseSlackInteractionPayload(body)).toEqual({
      slackUserId: "U-PRIYA",
      actionId: "counter:agr_001",
      agreementId: "agr_001",
      kind: "counter",
      optionId: undefined,
    });
  });

  it("returns null for a body with no payload field", () => {
    expect(parseSlackInteractionPayload("foo=bar")).toBeNull();
  });

  it("returns null for unparsable JSON", () => {
    expect(parseSlackInteractionPayload("payload=not-json")).toBeNull();
  });

  it("returns null when the action value has an unrecognised kind", () => {
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        user: { id: "U-ARJUN" },
        actions: [
          {
            action_id: "whatever",
            value: JSON.stringify({ agreementId: "agr_001", kind: "decline" }),
          },
        ],
      }),
    )}`;
    expect(parseSlackInteractionPayload(body)).toBeNull();
  });

  it("returns null when there is no user or no action", () => {
    const noUser = `payload=${encodeURIComponent(JSON.stringify({ actions: [] }))}`;
    expect(parseSlackInteractionPayload(noUser)).toBeNull();
  });
});

describe("handleSlackInteraction", () => {
  function deps(over: Partial<SlackInteractionDeps> = {}): SlackInteractionDeps {
    const identity: ChatIdentityResolver = {
      resolveParticipantId: vi.fn(async (externalId) =>
        externalId === "U-ARJUN" ? "prt_arjun" : null,
      ),
    };
    const responder: AgreementResponder = { respond: vi.fn(async () => {}) };
    return {
      signingSecret: SECRET,
      identity,
      responder,
      now: () => NOW,
      ...over,
    };
  }

  it("401s when the signature headers are missing", async () => {
    const res = await handleSlackInteraction(
      { rawBody: acceptBody(), headers: {} },
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("401s on an invalid signature", async () => {
    const body = acceptBody();
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": "v0=deadbeef",
        },
      },
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("400s on a validly signed but unrecognised payload", async () => {
    const body = "payload=not-json";
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": sign(body),
        },
      },
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("writes the response and acks 200 for a known participant's accept", async () => {
    const body = acceptBody();
    const d = deps();
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": sign(body),
        },
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(d.responder.respond).toHaveBeenCalledWith({
      agreementId: "agr_001",
      participantId: "prt_arjun",
      kind: "accept",
      optionId: "opt_2",
    });
  });

  it("acks 200 without writing anything for an unmapped Slack identity", async () => {
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        user: { id: "U-STRANGER" },
        actions: [
          {
            action_id: "agree:agr_001:opt_2",
            value: JSON.stringify({
              agreementId: "agr_001",
              optionId: "opt_2",
              kind: "accept",
            }),
          },
        ],
      }),
    )}`;
    const onUnhandled = vi.fn();
    const d = deps({ onUnhandled });
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": sign(body),
        },
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(d.responder.respond).not.toHaveBeenCalled();
    expect(onUnhandled).toHaveBeenCalledWith(
      "unmapped_identity",
      expect.objectContaining({ slackUserId: "U-STRANGER" }),
    );
  });

  it("acks 200 without writing anything for a counter click", async () => {
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        user: { id: "U-ARJUN" },
        actions: [
          {
            action_id: "counter:agr_001",
            value: JSON.stringify({ agreementId: "agr_001", kind: "counter" }),
          },
        ],
      }),
    )}`;
    const onUnhandled = vi.fn();
    const d = deps({ onUnhandled });
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": sign(body),
        },
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(d.responder.respond).not.toHaveBeenCalled();
    expect(onUnhandled).toHaveBeenCalledWith(
      "counter_not_implemented",
      expect.objectContaining({ agreementId: "agr_001" }),
    );
  });

  it("500s and reports when the responder rejects", async () => {
    const body = acceptBody();
    const onUnhandled = vi.fn();
    const responder: AgreementResponder = {
      respond: vi.fn(async () => {
        throw new Error("prt_arjun is not a party to agreement agr_001");
      }),
    };
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": sign(body),
        },
      },
      deps({ responder, onUnhandled }),
    );
    expect(res.status).toBe(500);
    expect(onUnhandled).toHaveBeenCalledWith(
      "respond_failed",
      expect.objectContaining({ agreementId: "agr_001" }),
    );
  });
});
