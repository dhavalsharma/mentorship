import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildCounterModalView,
  handleSlackInteraction,
  parseSlackInteractionPayload,
  parseSlackViewSubmission,
  verifySlackSignature,
  type AgreementResponder,
  type ChatIdentityResolver,
  type ExtractionResponder,
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

function confirmBody(kind: "confirm" | "edit" = "confirm"): string {
  const payload = {
    user: { id: "U-ARJUN" },
    actions: [
      {
        action_id: `${kind}_extraction:ext_001`,
        value: JSON.stringify({ extractionId: "ext_001", kind }),
      },
    ],
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function signedHeaders(body: string): Record<string, string> {
  return {
    "x-slack-request-timestamp": TS,
    "x-slack-signature": sign(body),
  };
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
      target: "agreement",
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
      target: "agreement",
      slackUserId: "U-PRIYA",
      actionId: "counter:agr_001",
      agreementId: "agr_001",
      kind: "counter",
      optionId: undefined,
    });
  });

  it("parses a confirm click", () => {
    expect(parseSlackInteractionPayload(confirmBody())).toEqual({
      target: "extraction",
      slackUserId: "U-ARJUN",
      actionId: "confirm_extraction:ext_001",
      extractionId: "ext_001",
      kind: "confirm",
    });
  });

  it("parses an edit click", () => {
    expect(parseSlackInteractionPayload(confirmBody("edit"))).toEqual({
      target: "extraction",
      slackUserId: "U-ARJUN",
      actionId: "edit_extraction:ext_001",
      extractionId: "ext_001",
      kind: "edit",
    });
  });

  it("returns null when an extraction click carries an unrecognised kind", () => {
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        user: { id: "U-ARJUN" },
        actions: [
          {
            action_id: "confirm_extraction:ext_001",
            value: JSON.stringify({ extractionId: "ext_001", kind: "accept" }),
          },
        ],
      }),
    )}`;
    expect(parseSlackInteractionPayload(body)).toBeNull();
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

  it("acks 200 without writing anything for a counter click with no modal wired", async () => {
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
      "counter_modal_not_configured",
      expect.objectContaining({ agreementId: "agr_001" }),
    );
  });

  it("writes the verdict and acks 200 for a confirm click", async () => {
    const extractions: ExtractionResponder = { respond: vi.fn(async () => {}) };
    const body = confirmBody();
    const d = deps({ extractions });
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      d,
    );
    expect(res.status).toBe(200);
    expect(extractions.respond).toHaveBeenCalledWith({
      extractionId: "ext_001",
      participantId: "prt_arjun",
      kind: "confirm",
    });
    // The agreement path must not have been touched by an extraction click.
    expect(d.responder.respond).not.toHaveBeenCalled();
  });

  it("records an edit as its own verdict", async () => {
    const extractions: ExtractionResponder = { respond: vi.fn(async () => {}) };
    const body = confirmBody("edit");
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      deps({ extractions }),
    );
    expect(res.status).toBe(200);
    expect(extractions.respond).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "edit" }),
    );
  });

  it("acks a confirm click and records it when no extraction responder is wired", async () => {
    const onUnhandled = vi.fn();
    const body = confirmBody();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      deps({ onUnhandled }),
    );
    expect(res.status).toBe(200);
    expect(onUnhandled).toHaveBeenCalledWith(
      "extraction_responder_not_configured",
      expect.objectContaining({ extractionId: "ext_001" }),
    );
  });

  it("500s when the extraction responder rejects a non-party", async () => {
    const onUnhandled = vi.fn();
    const extractions: ExtractionResponder = {
      respond: vi.fn(async () => {
        throw new Error("prt_arjun is not a party to extraction ext_001");
      }),
    };
    const body = confirmBody();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      deps({ extractions, onUnhandled }),
    );
    expect(res.status).toBe(500);
    expect(onUnhandled).toHaveBeenCalledWith(
      "extraction_respond_failed",
      expect.objectContaining({ extractionId: "ext_001" }),
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

/**
 * "Suggest another", end to end through the endpoint: the click opens a modal
 * synchronously (the trigger_id is spent in this request or not at all), and
 * the submission is the first thing in this repo to write a real `counter`
 * response — a structured date and time, never prose (invariant 9).
 */
describe("the counter-proposal modal", () => {
  function counterClickBody(overrides: Record<string, unknown> = {}): string {
    return `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        user: { id: "U-ARJUN" },
        trigger_id: "trg-123.456",
        actions: [
          {
            action_id: "counter:agr_001",
            value: JSON.stringify({ agreementId: "agr_001", kind: "counter" }),
          },
        ],
        ...overrides,
      }),
    )}`;
  }

  function submissionBody(
    values: Record<string, unknown> | null = null,
    metadata = JSON.stringify({ agreementId: "agr_001" }),
  ): string {
    return `payload=${encodeURIComponent(
      JSON.stringify({
        type: "view_submission",
        user: { id: "U-ARJUN" },
        view: {
          callback_id: "counter_proposal",
          private_metadata: metadata,
          state: {
            values: values ?? {
              counter_date: {
                counter_date_value: {
                  type: "datepicker",
                  selected_date: "2026-09-21",
                },
              },
              counter_time: {
                counter_time_value: {
                  type: "timepicker",
                  selected_time: "14:30",
                },
              },
            },
          },
        },
      }),
    )}`;
  }

  function modalDeps(
    over: Partial<SlackInteractionDeps> = {},
  ): SlackInteractionDeps {
    const identity: ChatIdentityResolver = {
      resolveParticipantId: vi.fn(async (externalId) =>
        externalId === "U-ARJUN" ? "prt_arjun" : null,
      ),
    };
    return {
      signingSecret: SECRET,
      identity,
      responder: { respond: vi.fn(async () => {}) },
      modals: { openCounterModal: vi.fn(async () => {}) },
      counters: {
        // +05:30, 45-minute sessions — the same shape the Postgres resolver
        // returns off the program's cadence.
        resolve: vi.fn(async () => ({
          tzOffsetMinutes: 330,
          sessionMinutes: 45,
        })),
      },
      now: () => NOW,
      ...over,
    };
  }

  it("builds a view carrying the agreement id in private_metadata", () => {
    const view = buildCounterModalView({ agreementId: "agr_001" });
    expect(JSON.parse(String(view["private_metadata"]))).toEqual({
      agreementId: "agr_001",
    });
    const blocks = view["blocks"] as {
      block_id: string;
      element: { type: string };
    }[];
    expect(blocks.map((b) => b.block_id)).toEqual([
      "counter_date",
      "counter_time",
    ]);
    expect(blocks.map((b) => b.element.type)).toEqual([
      "datepicker",
      "timepicker",
    ]);
  });

  it("opens the modal with the click's trigger_id, inside the click's request", async () => {
    const body = counterClickBody();
    const d = modalDeps();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      d,
    );
    expect(res.status).toBe(200);
    expect(d.modals!.openCounterModal).toHaveBeenCalledWith({
      triggerId: "trg-123.456",
      agreementId: "agr_001",
    });
    // No fact is written by opening a view.
    expect(d.responder.respond).not.toHaveBeenCalled();
  });

  it("acks rather than erroring at the user when views.open fails", async () => {
    const onUnhandled = vi.fn();
    const body = counterClickBody();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      modalDeps({
        modals: {
          openCounterModal: vi.fn(async () => {
            throw new Error("slack views.open failed: expired_trigger_id");
          }),
        },
        onUnhandled,
      }),
    );
    expect(res.status).toBe(200);
    expect(onUnhandled).toHaveBeenCalledWith(
      "counter_modal_open_failed",
      expect.objectContaining({ agreementId: "agr_001" }),
    );
  });

  it("parses a submission's picked date and time out of view.state.values", () => {
    expect(parseSlackViewSubmission(submissionBody())).toEqual({
      slackUserId: "U-ARJUN",
      agreementId: "agr_001",
      date: "2026-09-21",
      time: "14:30",
    });
  });

  it("returns null for a submission whose private_metadata carries no agreement", () => {
    expect(parseSlackViewSubmission(submissionBody(null, "{}"))).toBeNull();
    expect(parseSlackViewSubmission(submissionBody(null, "not-json"))).toBeNull();
  });

  it("401s a submission before parsing it when the signature is wrong", async () => {
    const body = submissionBody();
    const d = modalDeps();
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": TS,
          "x-slack-signature": "v0=deadbeef",
        },
      },
      d,
    );
    expect(res.status).toBe(401);
    expect(d.responder.respond).not.toHaveBeenCalled();
  });

  it("writes a counter response with a UTC instant built from the submitter's offset", async () => {
    const body = submissionBody();
    const d = modalDeps();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      d,
    );
    // An empty 200 is what closes the modal.
    expect(res.status).toBe(200);
    expect(res.body ?? "").toBe("");
    expect(d.responder.respond).toHaveBeenCalledWith({
      agreementId: "agr_001",
      participantId: "prt_arjun",
      kind: "counter",
      counter: expect.objectContaining({
        optionId: "opt_counter",
        // 14:30 at +05:30 is 09:00 UTC, and a 45-minute session ends at 09:45.
        startsAt: "2026-09-21T09:00:00.000Z",
        endsAt: "2026-09-21T09:45:00.000Z",
      }),
    });
  });

  it("answers an empty date with an inline field error, not a silent failure", async () => {
    const body = submissionBody({
      counter_date: { counter_date_value: { type: "datepicker" } },
      counter_time: {
        counter_time_value: { type: "timepicker", selected_time: "14:30" },
      },
    });
    const d = modalDeps();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      d,
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json");
    expect(JSON.parse(res.body!)).toEqual({
      response_action: "errors",
      errors: { counter_date: "Pick a date." },
    });
    expect(d.responder.respond).not.toHaveBeenCalled();
  });

  it("answers a closed or foreign agreement with an inline error", async () => {
    const body = submissionBody();
    const d = modalDeps({ counters: { resolve: vi.fn(async () => null) } });
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      d,
    );
    expect(JSON.parse(res.body!)).toMatchObject({ response_action: "errors" });
    expect(d.responder.respond).not.toHaveBeenCalled();
  });

  it("surfaces a rejected write in the modal rather than 500ing", async () => {
    const body = submissionBody();
    const onUnhandled = vi.fn();
    const d = modalDeps({
      responder: {
        respond: vi.fn(async () => {
          throw new Error("prt_arjun is not a party to agreement agr_001");
        }),
      },
      onUnhandled,
    });
    const res = await handleSlackInteraction(
      { rawBody: body, headers: signedHeaders(body) },
      d,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ response_action: "errors" });
    expect(onUnhandled).toHaveBeenCalledWith(
      "counter_respond_failed",
      expect.objectContaining({ agreementId: "agr_001" }),
    );
  });
});
