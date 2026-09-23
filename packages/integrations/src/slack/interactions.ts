import {
  describeCadence,
  formatSlotLabel,
  PAIR_PREFERENCES_DISABLED_MESSAGE,
  resolvePairPreferences,
  wallClockToUtc,
  type PairPreferences,
  type PreferenceField,
  type ProposalOption,
  type ResponseKind,
} from "@mentorship/core";
import { verifySlackSignature } from "./verify.js";
import {
  buildPreferencesSavedView,
  COUNTER_DATE_BLOCK,
  COUNTER_TIME_BLOCK,
  parsePreferencesSubmission,
  parseSlackViewSubmission,
  PREF_CADENCE_BLOCK,
  PREF_CADENCE_CUSTOM_BLOCK,
  PREF_SESSION_BLOCK,
  PREF_SESSION_CUSTOM_BLOCK,
  PREFERENCES_CALLBACK_ID,
  slackInteractionType,
  slackViewCallbackId,
  type PreferencesModalContext,
  type SlackModalOpener,
  type SlackPreferencesModalOpener,
} from "./modal.js";

/**
 * The interaction endpoint. Two rules from `conversation.ts`'s operational
 * notes apply directly here: verify the signature against the raw body
 * before touching anything else, and never do the real work before
 * acknowledging — write the fact, return 200, and let the saga advance when
 * the outbox relay picks the event up. Doing the work first is how a
 * successful click ends up showing the user an error.
 */

/**
 * Two kinds of structured decision arrive here, and they are kept apart by
 * `target` rather than by inspecting which id happens to be present: a third
 * button type should fail to compile until it is handled, not fall through a
 * chain of `if (agreementId)`.
 */
export type ParsedSlackAction =
  | {
      target: "agreement";
      slackUserId: string;
      actionId: string;
      agreementId: string;
      kind: "accept" | "counter";
      optionId?: string;
      /**
       * Present on every block action, and good for about three seconds — the
       * only thing that can open a modal, and the reason the counter path is
       * handled in the request rather than by an effect.
       */
      triggerId?: string;
    }
  | {
      target: "extraction";
      slackUserId: string;
      actionId: string;
      extractionId: string;
      kind: "confirm" | "edit";
    }
  | {
      target: "preferences";
      slackUserId: string;
      actionId: string;
      pairingId: string;
      kind: "preferences";
      triggerId?: string;
    };

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

  const actionId = String(action["action_id"]);
  const kind = v["kind"];

  const extractionId = v["extractionId"];
  if (typeof extractionId === "string") {
    if (kind !== "confirm" && kind !== "edit") return null;
    return {
      target: "extraction",
      slackUserId,
      actionId,
      extractionId,
      kind,
    };
  }

  const triggerId = p["trigger_id"];

  const pairingId = v["pairingId"];
  if (typeof pairingId === "string") {
    if (kind !== "preferences") return null;
    return {
      target: "preferences",
      slackUserId,
      actionId,
      pairingId,
      kind,
      triggerId: typeof triggerId === "string" ? triggerId : undefined,
    };
  }

  const agreementId = v["agreementId"];
  if (typeof agreementId !== "string") return null;
  if (kind !== "accept" && kind !== "counter") return null;

  const optionId = v["optionId"];
  return {
    target: "agreement",
    slackUserId,
    actionId,
    agreementId,
    kind,
    optionId: typeof optionId === "string" ? optionId : undefined,
    triggerId: typeof triggerId === "string" ? triggerId : undefined,
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
    /** Set for `counter` — core's `AgreementResponse.counter`, end to end. */
    counter?: ProposalOption;
  }): Promise<void>;
}

/**
 * What a counter-proposal needs that the modal cannot carry: the submitter's
 * fixed timezone offset (the modal's date and time are wall-clock in their own
 * zone) and how long a session is for this program. Both are reads, which is
 * why they are a separate port from the write above.
 *
 * Returning null is the "no longer open, or not your agreement" answer, and it
 * becomes an inline modal error rather than a thrown 500.
 */
export interface CounterContextResolver {
  resolve(input: {
    agreementId: string;
    participantId: string;
  }): Promise<{ tzOffsetMinutes: number; sessionMinutes: number } | null>;
}

/**
 * The sibling of `AgreementResponder` for the other decision a participant is
 * asked to make. Kept separate rather than folded into one responder: the two
 * write different facts about different subjects, and the agreement resolver's
 * five outcomes have nothing to say about an extraction.
 */
export interface ExtractionResponder {
  respond(input: {
    extractionId: string;
    participantId: string;
    kind: "confirm" | "edit";
  }): Promise<void>;
}

/**
 * A pair's own length and rhythm. Both methods refuse (null) a participant who
 * is not a party to the pairing — a forged pairing id in a button value must
 * not let a stranger re-time somebody else's mentoring.
 *
 * `update` writes the pair-level cadence override *and* its
 * `pair.preferences_updated` event in one transaction, the same outbox
 * discipline as `AgreementResponder`; it returns what the pair now has, for
 * the confirmation the modal shows. A refusal says *why*: the program can
 * turn choice off between the modal opening and Save, and telling that
 * person "you're not part of this pair" would be false.
 */
export type PairPreferencesUpdateResult =
  | { ok: true; sessionMinutes: number; everyDays: number }
  | { ok: false; reason: "not_member" | "disabled" };

export interface PairPreferencesStore {
  context(input: {
    pairingId: string;
    participantId: string;
  }): Promise<PreferencesModalContext | null>;
  update(input: {
    pairingId: string;
    participantId: string;
    preferences: PairPreferences;
  }): Promise<PairPreferencesUpdateResult>;
}


export interface SlackWebhookRequest {
  rawBody: string;
  headers: Record<string, string | undefined>;
}

export interface SlackWebhookResponse {
  status: number;
  body?: string;
  /** Defaults to text/plain; the Events API handshake answers with JSON. */
  contentType?: string;
}

export interface SlackInteractionDeps {
  signingSecret: string;
  identity: ChatIdentityResolver;
  responder: AgreementResponder;
  /**
   * Optional: a deployment that has not wired it yet acks the click and
   * records that it did nothing, rather than 500ing at a participant who did
   * exactly what the message asked.
   */
  extractions?: ExtractionResponder;
  /**
   * Opens the "Suggest another" modal. Absent, a counter click acks and is
   * recorded as unhandled — the behaviour this endpoint had before the modal
   * existed, which is still the right answer for a deployment with no bot
   * token to call `views.open` with.
   */
  modals?: SlackModalOpener;
  /** Reads needed to turn a submitted date+time into a `ProposalOption`. */
  counters?: CounterContextResolver;
  /**
   * "Session preferences". Absent, the click acks and is recorded as
   * unhandled — the same honest no-op as a counter with no modal opener.
   */
  preferences?: {
    modals: SlackPreferencesModalOpener;
    store: PairPreferencesStore;
  };
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

  // Both payload types arrive at this one Request URL, and both are signed the
  // same way — so the branch belongs *after* verification and before any
  // block_actions-specific parsing, which a view_submission would otherwise
  // fail as "unrecognised".
  if (slackInteractionType(req.rawBody) === "view_submission") {
    // Routed on `callback_id`. Anything that is not the preferences modal
    // goes to the counter handler, which is what every submission meant
    // before there were two — so a counter modal already open in someone's
    // client when this shipped still lands where it always did.
    if (slackViewCallbackId(req.rawBody) === PREFERENCES_CALLBACK_ID) {
      return handlePreferencesSubmission(req.rawBody, deps);
    }
    return handleCounterSubmission(req.rawBody, deps);
  }

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

  if (action.target === "extraction") {
    if (!deps.extractions) {
      deps.onUnhandled?.("extraction_responder_not_configured", {
        extractionId: action.extractionId,
        participantId,
      });
      return { status: 200 };
    }
    try {
      // The same shape as the agreement path: write the verdict, ack, and let
      // the relay carry `extraction.confirmed` / `extraction.edited` to the
      // saga. "Edit" is a verdict too — it says a human looked — and the
      // editing itself happens in the document the button links to.
      await deps.extractions.respond({
        extractionId: action.extractionId,
        participantId,
        kind: action.kind,
      });
    } catch (error) {
      deps.onUnhandled?.("extraction_respond_failed", {
        extractionId: action.extractionId,
        participantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 500, body: "failed to record confirmation" };
    }
    return { status: 200 };
  }

  if (action.target === "preferences") {
    if (!deps.preferences || !action.triggerId) {
      deps.onUnhandled?.("preferences_modal_not_configured", {
        pairingId: action.pairingId,
        participantId,
        hasTriggerId: Boolean(action.triggerId),
      });
      return { status: 200 };
    }
    try {
      // One indexed read before `views.open`, inside the trigger's ~3s life.
      // Worth it: the modal pre-selects what the pair has now, and the read is
      // also the membership check — a stranger never sees the menu at all.
      const context = await deps.preferences.store.context({
        pairingId: action.pairingId,
        participantId,
      });
      if (!context) {
        deps.onUnhandled?.("preferences_not_pair_member", {
          pairingId: action.pairingId,
          participantId,
        });
        return { status: 200 };
      }
      // A button on a proposal posted before the program turned choice off.
      // Opening a full menu only to refuse it at Save is worse than nothing.
      if (!context.policy.enabled) {
        deps.onUnhandled?.("preferences_disabled", {
          pairingId: action.pairingId,
          participantId,
        });
        return { status: 200 };
      }
      await deps.preferences.modals.openPreferencesModal({
        triggerId: action.triggerId,
        pairingId: action.pairingId,
        context,
      });
    } catch (error) {
      deps.onUnhandled?.("preferences_modal_open_failed", {
        pairingId: action.pairingId,
        participantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: 200 };
  }

  if (action.kind === "counter") {
    if (!deps.modals || !action.triggerId) {
      deps.onUnhandled?.("counter_modal_not_configured", {
        agreementId: action.agreementId,
        participantId,
        hasTriggerId: Boolean(action.triggerId),
      });
      return { status: 200 };
    }
    try {
      // Synchronously, inside this request: the trigger_id expires in about
      // three seconds, so handing this to the effect runner (which the worker
      // drains later) would open nothing at all.
      await deps.modals.openCounterModal({
        triggerId: action.triggerId,
        agreementId: action.agreementId,
      });
    } catch (error) {
      deps.onUnhandled?.("counter_modal_open_failed", {
        agreementId: action.agreementId,
        participantId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Nothing was written, and Slack retrying the click cannot help — the
      // trigger is spent either way. Ack rather than show a red error.
      return { status: 200 };
    }
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

/**
 * Slack reads an empty 200 as "close the modal", and a body of
 * `{response_action: "errors", errors: {<block_id>: "..."}}` as "keep it open
 * and show this under that field". The second is the only way a participant
 * learns *why* their suggestion did not take; the alternative is a generic
 * toast and a lost counter-proposal.
 */
function modalError(
  blockId: string,
  message: string,
): SlackWebhookResponse {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      response_action: "errors",
      errors: { [blockId]: message },
    }),
  };
}

async function handleCounterSubmission(
  rawBody: string,
  deps: SlackInteractionDeps,
): Promise<SlackWebhookResponse> {
  const submission = parseSlackViewSubmission(rawBody);
  if (!submission) return { status: 400, body: "unrecognised view submission" };

  const participantId = await deps.identity.resolveParticipantId(
    submission.slackUserId,
  );
  if (!participantId) {
    deps.onUnhandled?.("unmapped_identity", {
      slackUserId: submission.slackUserId,
    });
    return modalError(
      COUNTER_DATE_BLOCK,
      "We couldn't match your Slack account to this program.",
    );
  }

  if (!deps.counters) {
    deps.onUnhandled?.("counter_context_not_configured", {
      agreementId: submission.agreementId,
      participantId,
    });
    return modalError(
      COUNTER_DATE_BLOCK,
      "Suggesting a time isn't available here yet.",
    );
  }

  if (!submission.date) {
    return modalError(COUNTER_DATE_BLOCK, "Pick a date.");
  }
  if (!submission.time) {
    return modalError(COUNTER_TIME_BLOCK, "Pick a start time.");
  }

  const context = await deps.counters.resolve({
    agreementId: submission.agreementId,
    participantId,
  });
  if (!context) {
    return modalError(
      COUNTER_DATE_BLOCK,
      "That proposal is no longer open. Wait for the next one.",
    );
  }

  // The modal's date and time are wall-clock in the submitter's own zone; the
  // agreement only ever stores instants (invariant 21).
  const startsAt = wallClockToUtc({
    date: submission.date,
    time: submission.time,
    tzOffsetMinutes: context.tzOffsetMinutes,
  });
  if (!startsAt) {
    return modalError(COUNTER_DATE_BLOCK, "That date and time didn't parse.");
  }
  const endsAt = new Date(
    Date.parse(startsAt) + context.sessionMinutes * 60_000,
  ).toISOString();

  const counter: ProposalOption = {
    // Not `opt_N`: the saga re-numbers options when it re-proposes, and a
    // counter that arrived with an id shaped like a slot from the round it is
    // answering is an easy thing to mistake for one.
    optionId: "opt_counter",
    startsAt,
    endsAt,
    // The same formatter the generated options use, so the re-proposal does
    // not mix two label styles — and so the *other* participant sees a zone,
    // not a bare wall-clock time that means nothing to them.
    label: formatSlotLabel(Date.parse(startsAt), [
      {
        memberRef: participantId,
        tzOffsetMinutes: context.tzOffsetMinutes,
        busy: [],
      },
    ]),
  };

  try {
    await deps.responder.respond({
      agreementId: submission.agreementId,
      participantId,
      kind: "counter",
      counter,
    });
  } catch (error) {
    deps.onUnhandled?.("counter_respond_failed", {
      agreementId: submission.agreementId,
      participantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return modalError(
      COUNTER_DATE_BLOCK,
      "We couldn't record that suggestion. Try again.",
    );
  }

  // Empty 200 closes the modal. The saga moves when the relay drains the
  // `agreement.responded` this wrote — same discipline as every other click.
  return { status: 200 };
}

const PREFERENCE_BLOCKS: Record<PreferenceField, string> = {
  sessionChoice: PREF_SESSION_BLOCK,
  sessionCustom: PREF_SESSION_CUSTOM_BLOCK,
  cadenceChoice: PREF_CADENCE_BLOCK,
  cadenceCustom: PREF_CADENCE_CUSTOM_BLOCK,
};

async function handlePreferencesSubmission(
  rawBody: string,
  deps: SlackInteractionDeps,
): Promise<SlackWebhookResponse> {
  const submission = parsePreferencesSubmission(rawBody);
  if (!submission) return { status: 400, body: "unrecognised view submission" };

  const participantId = await deps.identity.resolveParticipantId(
    submission.slackUserId,
  );
  if (!participantId) {
    deps.onUnhandled?.("unmapped_identity", {
      slackUserId: submission.slackUserId,
    });
    return modalError(
      PREF_SESSION_BLOCK,
      "We couldn't match your Slack account to this program.",
    );
  }
  if (!deps.preferences) {
    deps.onUnhandled?.("preferences_store_not_configured", {
      pairingId: submission.pairingId,
      participantId,
    });
    return modalError(PREF_SESSION_BLOCK, "Changing preferences isn't available here yet.");
  }

  // Re-read rather than trusting what the modal was opened with: the program
  // may have changed its menu, or turned choice off, while the modal sat open.
  const context = await deps.preferences.store.context({
    pairingId: submission.pairingId,
    participantId,
  });
  if (!context) {
    return modalError(PREF_SESSION_BLOCK, "You're not part of this pair.");
  }

  const resolved = resolvePairPreferences(submission, context.policy);
  if (!resolved.ok) {
    return modalError(PREFERENCE_BLOCKS[resolved.field], resolved.message);
  }

  let saved: PairPreferencesUpdateResult;
  try {
    saved = await deps.preferences.store.update({
      pairingId: submission.pairingId,
      participantId,
      preferences: resolved.preferences,
    });
  } catch (error) {
    deps.onUnhandled?.("preferences_update_failed", {
      pairingId: submission.pairingId,
      participantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return modalError(PREF_SESSION_BLOCK, "We couldn't save that. Try again.");
  }
  if (!saved.ok) {
    return modalError(
      PREF_SESSION_BLOCK,
      saved.reason === "disabled"
        ? PAIR_PREFERENCES_DISABLED_MESSAGE
        : "You're not part of this pair.",
    );
  }

  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      response_action: "update",
      view: buildPreferencesSavedView(describeCadence(saved)),
    }),
  };
}
