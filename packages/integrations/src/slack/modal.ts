import type { SlackTransport } from "./conversation.js";

/**
 * "Suggest another", as a modal.
 *
 * Why a modal and not a typed reply: a counter-proposal is a *structured* fact
 * — a new date and a new time — and invariant 9 forbids inferring one from
 * prose. Slack's `datepicker`/`timepicker` hand back exactly that, with no
 * parsing of free text anywhere in the path.
 *
 * Why this is not a `ConversationAdapter` method: the `trigger_id` that
 * authorises `views.open` lives for about three seconds and is single-use, so
 * the view has to be opened *synchronously inside the request that received
 * the click*. Every other outbound Slack call in this repo is an effect the
 * worker's relay loop runs, which may be seconds or minutes later — that path
 * would reliably hand Slack an expired trigger. Opening a view also writes no
 * fact; it is UI, so it belongs with signature verification and identity
 * resolution in `apps/api`, not with the saga-facing ports.
 */

export const COUNTER_DATE_BLOCK = "counter_date";
export const COUNTER_DATE_ACTION = "counter_date_value";
export const COUNTER_TIME_BLOCK = "counter_time";
export const COUNTER_TIME_ACTION = "counter_time_value";

export interface SlackModalOpener {
  openCounterModal(input: {
    triggerId: string;
    agreementId: string;
  }): Promise<void>;
}

/**
 * `private_metadata` is JSON rather than a bare id so a second field (a round,
 * a pairing) can be added without a format migration on views already open in
 * somebody's client.
 */
export function buildCounterModalView(input: {
  agreementId: string;
}): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "counter_proposal",
    private_metadata: JSON.stringify({ agreementId: input.agreementId }),
    title: { type: "plain_text", text: "Suggest a time" },
    submit: { type: "plain_text", text: "Suggest" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: COUNTER_DATE_BLOCK,
        label: { type: "plain_text", text: "Date" },
        element: {
          type: "datepicker",
          action_id: COUNTER_DATE_ACTION,
          placeholder: { type: "plain_text", text: "Pick a date" },
        },
      },
      {
        type: "input",
        block_id: COUNTER_TIME_BLOCK,
        label: { type: "plain_text", text: "Start time (your local time)" },
        element: {
          type: "timepicker",
          action_id: COUNTER_TIME_ACTION,
          placeholder: { type: "plain_text", text: "Pick a time" },
        },
      },
    ],
  };
}

/**
 * `views.open` needs no OAuth scope of its own beyond the app having
 * interactivity enabled — `chat:write` already covers everything this app
 * sends. STATUS: the API shape is real; never run against a live workspace.
 */
export class SlackWebApiModalOpener implements SlackModalOpener {
  constructor(private readonly call: SlackTransport) {}

  async openCounterModal(input: {
    triggerId: string;
    agreementId: string;
  }): Promise<void> {
    await this.call("views.open", {
      trigger_id: input.triggerId,
      view: buildCounterModalView({ agreementId: input.agreementId }),
    });
  }
}

export interface ParsedSlackViewSubmission {
  slackUserId: string;
  agreementId: string;
  /** `YYYY-MM-DD` as the datepicker reports it, or null when left empty. */
  date: string | null;
  /** `HH:MM`, 24h, as the timepicker reports it, or null when left empty. */
  time: string | null;
}

/** The `type` field of an interaction payload, without committing to a shape. */
export function slackInteractionType(rawBody: string): string | null {
  const payload = decodePayload(rawBody);
  if (!payload) return null;
  const type = payload["type"];
  return typeof type === "string" ? type : null;
}

/**
 * Slack keys view state as `values[block_id][action_id]`, which is easy to get
 * subtly wrong by reading one level too few. Anything missing comes back as
 * null so the handler can answer with a field-level error rather than a 500.
 */
export function parseSlackViewSubmission(
  rawBody: string,
): ParsedSlackViewSubmission | null {
  const payload = decodePayload(rawBody);
  if (!payload) return null;
  if (payload["type"] !== "view_submission") return null;

  const user = payload["user"] as Record<string, unknown> | undefined;
  const slackUserId = user?.["id"];
  const view = payload["view"] as Record<string, unknown> | undefined;
  if (typeof slackUserId !== "string" || !view) return null;

  let agreementId: unknown;
  try {
    const metadata = JSON.parse(String(view["private_metadata"] ?? "")) as
      | Record<string, unknown>
      | null;
    agreementId = metadata?.["agreementId"];
  } catch {
    return null;
  }
  if (typeof agreementId !== "string" || agreementId.length === 0) return null;

  const state = view["state"] as Record<string, unknown> | undefined;
  const values = state?.["values"] as Record<string, unknown> | undefined;

  return {
    slackUserId,
    agreementId,
    date: readValue(values, COUNTER_DATE_BLOCK, COUNTER_DATE_ACTION, "selected_date"),
    time: readValue(values, COUNTER_TIME_BLOCK, COUNTER_TIME_ACTION, "selected_time"),
  };
}

function readValue(
  values: Record<string, unknown> | undefined,
  blockId: string,
  actionId: string,
  field: string,
): string | null {
  const block = values?.[blockId] as Record<string, unknown> | undefined;
  const element = block?.[actionId] as Record<string, unknown> | undefined;
  const value = element?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodePayload(rawBody: string): Record<string, unknown> | null {
  try {
    const raw = new URLSearchParams(rawBody).get("payload");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
