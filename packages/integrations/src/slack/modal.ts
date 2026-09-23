import {
  CUSTOM_CHOICE,
  describeCadence,
  describeEveryDays,
  type PairPreferencesPolicy,
  type PairPreferencesSubmission,
} from "@mentorship/core";
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

export const COUNTER_CALLBACK_ID = "counter_proposal";
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
    callback_id: COUNTER_CALLBACK_ID,
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
export class SlackWebApiModalOpener
  implements SlackModalOpener, SlackPreferencesModalOpener
{
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

  async openPreferencesModal(input: {
    triggerId: string;
    pairingId: string;
    context: PreferencesModalContext;
  }): Promise<void> {
    await this.call("views.open", {
      trigger_id: input.triggerId,
      view: buildPreferencesModalView({
        pairingId: input.pairingId,
        context: input.context,
      }),
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

// ---------------------------------------------------------------------------
// "Session preferences" — a pair choosing its own length and rhythm
// ---------------------------------------------------------------------------

/**
 * Same reasoning as the counter modal on every point: a length and a rhythm
 * are structured facts, so they come back off a select and a number field
 * rather than out of a sentence (invariant 9), and the view is opened inside
 * the click's own request because the trigger dies in about three seconds.
 *
 * The menu is built from the program's `pairPreferences` policy rather than
 * hardcoded here, so a program offering different choices changes data, not
 * this file.
 */

export const PREFERENCES_CALLBACK_ID = "pair_preferences";
export const PREF_SESSION_BLOCK = "pref_session";
export const PREF_SESSION_ACTION = "pref_session_value";
export const PREF_SESSION_CUSTOM_BLOCK = "pref_session_custom";
export const PREF_SESSION_CUSTOM_ACTION = "pref_session_custom_value";
export const PREF_CADENCE_BLOCK = "pref_cadence";
export const PREF_CADENCE_ACTION = "pref_cadence_value";
export const PREF_CADENCE_CUSTOM_BLOCK = "pref_cadence_custom";
export const PREF_CADENCE_CUSTOM_ACTION = "pref_cadence_custom_value";

export interface PreferencesModalContext {
  /** What the pair has now, after program -> cohort -> pair resolution. */
  sessionMinutes: number;
  everyDays: number;
  policy: PairPreferencesPolicy;
}

export interface SlackPreferencesModalOpener {
  openPreferencesModal(input: {
    triggerId: string;
    pairingId: string;
    context: PreferencesModalContext;
  }): Promise<void>;
}

function option(text: string, value: string): Record<string, unknown> {
  return { text: { type: "plain_text", text }, value };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Pre-selects what the pair has now. A current value that is not on the menu
 * (a roster import set 60 minutes; the program offers 15/30/45) shows as
 * "Custom" with the number filled in, so opening the modal and pressing Save
 * never silently changes anything.
 */
export function buildPreferencesModalView(input: {
  pairingId: string;
  context: PreferencesModalContext;
}): Record<string, unknown> {
  const { policy, sessionMinutes, everyDays } = input.context;

  const sessionOptions = [
    ...policy.sessionMinuteChoices.map((m) => option(`${m} minutes`, String(m))),
    ...(policy.allowCustomSessionMinutes ? [option("Custom", CUSTOM_CHOICE)] : []),
  ];
  const cadenceOptions = [
    ...policy.cadenceDayChoices.map((d) =>
      option(capitalise(describeEveryDays(d)), String(d)),
    ),
    ...(policy.allowCustomCadenceDays ? [option("Custom", CUSTOM_CHOICE)] : []),
  ];

  const sessionOnMenu = policy.sessionMinuteChoices.includes(sessionMinutes);
  const cadenceOnMenu = policy.cadenceDayChoices.includes(everyDays);
  const initial = (
    options: Record<string, unknown>[],
    onMenu: boolean,
    value: number,
  ): Record<string, unknown> => {
    const wanted = onMenu ? String(value) : CUSTOM_CHOICE;
    const found = options.find((o) => o["value"] === wanted);
    return found ? { initial_option: found } : {};
  };

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Right now: *${describeCadence({ sessionMinutes, everyDays })}*.\n` +
          "Either of you can change this. It applies from your next proposal, " +
          "and the thread is told when it changes.",
      },
    },
    {
      type: "input",
      block_id: PREF_SESSION_BLOCK,
      label: { type: "plain_text", text: "Session length" },
      element: {
        type: "static_select",
        action_id: PREF_SESSION_ACTION,
        options: sessionOptions,
        ...initial(sessionOptions, sessionOnMenu, sessionMinutes),
      },
    },
  ];
  if (policy.allowCustomSessionMinutes) {
    blocks.push({
      type: "input",
      block_id: PREF_SESSION_CUSTOM_BLOCK,
      optional: true,
      label: { type: "plain_text", text: "Custom length (minutes)" },
      element: {
        type: "number_input",
        action_id: PREF_SESSION_CUSTOM_ACTION,
        is_decimal_allowed: false,
        min_value: "15",
        max_value: "240",
        ...(sessionOnMenu ? {} : { initial_value: String(sessionMinutes) }),
      },
    });
  }
  blocks.push({
    type: "input",
    block_id: PREF_CADENCE_BLOCK,
    label: { type: "plain_text", text: "How often" },
    element: {
      type: "static_select",
      action_id: PREF_CADENCE_ACTION,
      options: cadenceOptions,
      ...initial(cadenceOptions, cadenceOnMenu, everyDays),
    },
  });
  if (policy.allowCustomCadenceDays) {
    blocks.push({
      type: "input",
      block_id: PREF_CADENCE_CUSTOM_BLOCK,
      optional: true,
      label: { type: "plain_text", text: "Custom rhythm (every N days)" },
      element: {
        type: "number_input",
        action_id: PREF_CADENCE_CUSTOM_ACTION,
        is_decimal_allowed: false,
        min_value: "1",
        max_value: "365",
        ...(cadenceOnMenu || everyDays <= 0
          ? {}
          : { initial_value: String(everyDays) }),
      },
    });
  }

  return {
    type: "modal",
    callback_id: PREFERENCES_CALLBACK_ID,
    private_metadata: JSON.stringify({ pairingId: input.pairingId }),
    title: { type: "plain_text", text: "Session preferences" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

/**
 * What the modal answers with after a successful save: it replaces itself
 * with the result, so the person who pressed Save sees exactly what took.
 */
export function buildPreferencesSavedView(summary: string): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Session preferences" },
    close: { type: "plain_text", text: "Done" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Saved: *${summary}*. This applies from your next proposal.`,
        },
      },
    ],
  };
}

export interface ParsedPreferencesSubmission extends PairPreferencesSubmission {
  slackUserId: string;
  pairingId: string;
}

/** The modal's `callback_id` — which of this app's views was submitted. */
export function slackViewCallbackId(rawBody: string): string | null {
  const payload = decodePayload(rawBody);
  const view = payload?.["view"] as Record<string, unknown> | undefined;
  const id = view?.["callback_id"];
  return typeof id === "string" ? id : null;
}

export function parsePreferencesSubmission(
  rawBody: string,
): ParsedPreferencesSubmission | null {
  const payload = decodePayload(rawBody);
  if (!payload || payload["type"] !== "view_submission") return null;
  const user = payload["user"] as Record<string, unknown> | undefined;
  const slackUserId = user?.["id"];
  const view = payload["view"] as Record<string, unknown> | undefined;
  if (typeof slackUserId !== "string" || !view) return null;

  let pairingId: unknown;
  try {
    const metadata = JSON.parse(String(view["private_metadata"] ?? "")) as
      | Record<string, unknown>
      | null;
    pairingId = metadata?.["pairingId"];
  } catch {
    return null;
  }
  if (typeof pairingId !== "string" || pairingId.length === 0) return null;

  const state = view["state"] as Record<string, unknown> | undefined;
  const values = state?.["values"] as Record<string, unknown> | undefined;
  const selected = (blockId: string, actionId: string): string | null => {
    const block = values?.[blockId] as Record<string, unknown> | undefined;
    const element = block?.[actionId] as Record<string, unknown> | undefined;
    const opt = element?.["selected_option"] as Record<string, unknown> | undefined;
    const value = opt?.["value"];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  return {
    slackUserId,
    pairingId,
    sessionChoice: selected(PREF_SESSION_BLOCK, PREF_SESSION_ACTION),
    sessionCustom: readValue(
      values,
      PREF_SESSION_CUSTOM_BLOCK,
      PREF_SESSION_CUSTOM_ACTION,
      "value",
    ),
    cadenceChoice: selected(PREF_CADENCE_BLOCK, PREF_CADENCE_ACTION),
    cadenceCustom: readValue(
      values,
      PREF_CADENCE_CUSTOM_BLOCK,
      PREF_CADENCE_CUSTOM_ACTION,
      "value",
    ),
  };
}
