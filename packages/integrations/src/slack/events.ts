import { verifySlackSignature } from "./verify.js";
import type {
  ChatIdentityResolver,
  SlackWebhookRequest,
  SlackWebhookResponse,
} from "./interactions.js";

/**
 * The Events API endpoint — the inbound half of the conversation, and the only
 * place in this repo where a participant's own prose enters the system.
 *
 * The same two rules as `interactions.ts` apply: verify the signature against
 * the raw body before touching anything else, and write the fact and return
 * 200 rather than doing the work (Slack retries anything slower than three
 * seconds, and a retry of a note is a second note).
 *
 * What this file deliberately does NOT do: read meaning out of the message. It
 * does not decide that "looks good" is a confirmation, that "yes" is an
 * agreement, or that "next Tuesday" is a slot — those are decisions, and
 * decisions arrive on buttons (invariant 9). The text is copied through
 * verbatim to `notes.submitted` as raw material for extraction, which already
 * treats it as untrusted (invariant 15). Sanitising, summarising or truncating
 * it here would only make the extraction's evidence spans point at something
 * the participant never wrote.
 */

export interface SlackUrlVerification {
  kind: "url_verification";
  challenge: string;
}

export interface SlackMessageEvent {
  kind: "message";
  channelId: string;
  slackUserId: string;
  /** Slack's message timestamp — unique per channel, and our idempotency anchor. */
  ts: string;
  text: string;
}

export interface SlackIgnoredEvent {
  kind: "ignored";
  reason: string;
}

export type ParsedSlackEvent =
  | SlackUrlVerification
  | SlackMessageEvent
  | SlackIgnoredEvent;

/**
 * Unlike the interaction endpoint, the Events API posts `application/json`
 * directly rather than a form-encoded `payload` field.
 */
export function parseSlackEventPayload(rawBody: string): ParsedSlackEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (p["type"] === "url_verification") {
    const challenge = p["challenge"];
    if (typeof challenge !== "string") return null;
    return { kind: "url_verification", challenge };
  }

  if (p["type"] !== "event_callback") {
    return { kind: "ignored", reason: `envelope_type:${String(p["type"])}` };
  }

  const event = p["event"];
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;

  if (e["type"] !== "message") {
    return { kind: "ignored", reason: `event_type:${String(e["type"])}` };
  }

  // A subtype means this is an edit, a deletion, a join, a file share or a
  // channel-topic change — never a person typing something new. Treating an
  // edit as a fresh note would let someone rewrite history after extraction.
  if (e["subtype"] !== undefined) {
    return { kind: "ignored", reason: `subtype:${String(e["subtype"])}` };
  }

  // Our own messages come back through the same subscription. Without this the
  // bot's own "How did it go?" prompt becomes the notes it was asking for.
  if (e["bot_id"] !== undefined || e["app_id"] !== undefined) {
    return { kind: "ignored", reason: "bot_message" };
  }

  const channelId = e["channel"];
  const slackUserId = e["user"];
  const ts = e["ts"];
  const text = e["text"];
  if (
    typeof channelId !== "string" ||
    typeof slackUserId !== "string" ||
    typeof ts !== "string"
  ) {
    return null;
  }

  return {
    kind: "message",
    channelId,
    slackUserId,
    ts,
    text: typeof text === "string" ? text : "",
  };
}

/**
 * Channel id -> the pair whose thread that channel is. The participant ids come
 * back with it so the caller can check that the person typing is actually a
 * party to the pair before their words become that pair's session record.
 */
export interface PairingLocator {
  resolveByChannel(
    channelId: string,
  ): Promise<{ pairingId: string; participantIds: string[] } | null>;
}

export interface NotesSink {
  submit(input: {
    pairingId: string;
    participantId: string;
    /** The Slack `ts`. A redelivery of the same message must not submit twice. */
    noteId: string;
    body: string;
  }): Promise<void>;
}

export interface SlackEventDeps {
  signingSecret: string;
  identity: ChatIdentityResolver;
  locator: PairingLocator;
  notes: NotesSink;
  /** Observability seam for the paths that ack but do nothing — not an error. */
  onUnhandled?: (reason: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
}

export async function handleSlackEvent(
  req: SlackWebhookRequest,
  deps: SlackEventDeps,
): Promise<SlackWebhookResponse> {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) {
    return { status: 401, body: "missing signature headers" };
  }

  // Before anything else, including the url_verification handshake: an
  // unverified events endpoint is an open door for anyone who can guess the
  // URL to write whatever they like into a pair's session record.
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

  const parsed = parseSlackEventPayload(req.rawBody);
  if (!parsed) return { status: 400, body: "unrecognised event" };

  if (parsed.kind === "url_verification") {
    // Slack posts this once, when the Request URL is saved, and expects the
    // challenge echoed straight back.
    return {
      status: 200,
      body: JSON.stringify({ challenge: parsed.challenge }),
      contentType: "application/json",
    };
  }

  if (parsed.kind === "ignored") {
    deps.onUnhandled?.("event_ignored", { reason: parsed.reason });
    return { status: 200 };
  }

  const participantId = await deps.identity.resolveParticipantId(
    parsed.slackUserId,
  );
  if (!participantId) {
    deps.onUnhandled?.("unmapped_identity", { slackUserId: parsed.slackUserId });
    return { status: 200 };
  }

  const pair = await deps.locator.resolveByChannel(parsed.channelId);
  if (!pair) {
    // The bot is in a conversation we have no pair for — someone invited it
    // somewhere, or the thread was bound before `pair.thread_bound` existed.
    deps.onUnhandled?.("unmapped_channel", { channelId: parsed.channelId });
    return { status: 200 };
  }

  if (!pair.participantIds.includes(participantId)) {
    // A known person, in the pair's channel, who is not a party to the pair —
    // an admin dropping in, say. Their words are not the pair's session record.
    deps.onUnhandled?.("participant_not_in_pair", {
      participantId,
      pairingId: pair.pairingId,
    });
    return { status: 200 };
  }

  try {
    await deps.notes.submit({
      pairingId: pair.pairingId,
      participantId,
      noteId: parsed.ts,
      // Verbatim. See the note at the top of this file.
      body: parsed.text,
    });
  } catch (error) {
    deps.onUnhandled?.("notes_submit_failed", {
      pairingId: pair.pairingId,
      participantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 500, body: "failed to record notes" };
  }

  return { status: 200 };
}
