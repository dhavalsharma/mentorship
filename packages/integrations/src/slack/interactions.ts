import type { ResponseKind } from "@mentorship/core";
import { verifySlackSignature } from "./verify.js";

/**
 * The interaction endpoint. Two rules from `conversation.ts`'s operational
 * notes apply directly here: verify the signature against the raw body
 * before touching anything else, and never do the real work before
 * acknowledging — write the fact, return 200, and let the saga advance when
 * the outbox relay picks the event up. Doing the work first is how a
 * successful click ends up showing the user an error.
 */

export interface ParsedSlackAction {
  slackUserId: string;
  actionId: string;
  agreementId: string;
  kind: "accept" | "counter";
  optionId?: string;
}

/**
 * `rawBody` is `application/x-www-form-urlencoded` with a single `payload`
 * field holding the interaction as JSON — Slack's actual wire format for
 * block actions, not something worth a form-parsing library for one field.
 */
export function parseSlackInteractionPayload(
  rawBody: string,
): ParsedSlackAction | null {
  let payload: unknown;
  try {
    const params = new URLSearchParams(rawBody);
    const raw = params.get("payload");
    if (!raw) return null;
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const user = p["user"] as Record<string, unknown> | undefined;
  const slackUserId = user?.["id"];
  const actions = p["actions"];
  const action = Array.isArray(actions)
    ? (actions[0] as Record<string, unknown> | undefined)
    : undefined;
  if (typeof slackUserId !== "string" || !action) return null;

  let value: unknown;
  try {
    value = JSON.parse(String(action["value"]));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const agreementId = v["agreementId"];
  const kind = v["kind"];
  if (typeof agreementId !== "string") return null;
  if (kind !== "accept" && kind !== "counter") return null;

  const optionId = v["optionId"];
  return {
    slackUserId,
    actionId: String(action["action_id"]),
    agreementId,
    kind,
    optionId: typeof optionId === "string" ? optionId : undefined,
  };
}

export interface ChatIdentityResolver {
  /** null means no verified mapping — never guess one from a name or email. */
  resolveParticipantId(externalId: string): Promise<string | null>;
}

export interface AgreementResponder {
  respond(input: {
    agreementId: string;
    participantId: string;
    kind: ResponseKind;
    optionId?: string;
  }): Promise<void>;
}

export interface SlackWebhookRequest {
  rawBody: string;
  headers: Record<string, string | undefined>;
}

export interface SlackWebhookResponse {
  status: number;
  body?: string;
}

export interface SlackInteractionDeps {
  signingSecret: string;
  identity: ChatIdentityResolver;
  responder: AgreementResponder;
  /** Observability seam for the paths that ack but do nothing — not an error. */
  onUnhandled?: (reason: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
}

export async function handleSlackInteraction(
  req: SlackWebhookRequest,
  deps: SlackInteractionDeps,
): Promise<SlackWebhookResponse> {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) {
    return { status: 401, body: "missing signature headers" };
  }

  const verified = verifySlackSignature(
    {
      signingSecret: deps.signingSecret,
      timestamp,
      rawBody: req.rawBody,
      signature,
    },
    deps.now?.(),
  );
  if (!verified) return { status: 401, body: "invalid signature" };

  const action = parseSlackInteractionPayload(req.rawBody);
  if (!action) return { status: 400, body: "unrecognised interaction" };

  const participantId = await deps.identity.resolveParticipantId(
    action.slackUserId,
  );
  if (!participantId) {
    // An unmapped identity is an enrolment gap, not a transient fault — ack so
    // Slack does not retry, and surface it for someone to fix the mapping.
    deps.onUnhandled?.("unmapped_identity", { slackUserId: action.slackUserId });
    return { status: 200 };
  }

  if (action.kind === "counter") {
    // "Suggest another" should open a modal to collect the new time; that
    // view and its view_submission handler are not built yet (ADR-0004's
    // open gap). Ack so the click does not show the user an error — there is
    // nothing to write yet.
    deps.onUnhandled?.("counter_not_implemented", {
      agreementId: action.agreementId,
      participantId,
    });
    return { status: 200 };
  }

  try {
    // Awaited because it is fast, and because it is the fact the deadline is
    // actually protecting. Advancing the saga is not this function's job —
    // that happens when the outbox relay picks the event up, and it can touch
    // a calendar and a document.
    await deps.responder.respond({
      agreementId: action.agreementId,
      participantId,
      kind: action.kind,
      optionId: action.optionId,
    });
  } catch (error) {
    // Could be a real fault, or a permanent one (this participant is not a
    // party to the agreement) — 500 so Slack retries, since nothing here can
    // tell the two apart without richer error types than `Error`.
    deps.onUnhandled?.("respond_failed", {
      agreementId: action.agreementId,
      participantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 500, body: "failed to record response" };
  }

  return { status: 200 };
}
