import type { Recorded } from "@mentorship/integrations";
import type { Party, Stage, StageEvent } from "./stage.js";

/**
 * Reading the two surfaces the way an operator would, and acting on what they
 * show the way a participant would. Everything here is derived from
 * `events()` or `calls()` — a journey learns an agreement id by reading the
 * `agreement.opened` the system announced, never by asking a repository.
 */

export interface OpenedAgreement {
  agreementId: string;
  pairingId: string;
  round: number;
  timeoutAt: string;
  options: { optionId: string; startsAt: string; endsAt: string; label: string }[];
}

export function agreementsOpened(events: StageEvent[], pairingId?: string): OpenedAgreement[] {
  return events
    .filter((e) => e.name === "agreement.opened")
    .map((e) => e.payload as unknown as OpenedAgreement)
    .filter((a) => pairingId === undefined || a.pairingId === pairingId);
}

export async function latestAgreement(stage: Stage, pairingId?: string): Promise<OpenedAgreement> {
  const opened = agreementsOpened(await stage.events(), pairingId ?? stage.pairingIds[0]);
  const last = opened.at(-1);
  if (!last) throw new Error("no agreement has been opened");
  return last;
}

export function named(events: StageEvent[], name: string): StageEvent[] {
  return events.filter((e) => e.name === name);
}

export function names(events: StageEvent[]): string[] {
  return events.map((e) => e.name);
}

/** The `reason` of every `saga.escalated` — which is how a pause is announced. */
export function escalations(events: StageEvent[]): string[] {
  return named(events, "saga.escalated").map((e) => String(e.payload["reason"]));
}

export function kinds(calls: Recorded[]): string[] {
  return calls.map((c) => c.kind);
}

export function ofKind(calls: Recorded[], kind: string): Recorded[] {
  return calls.filter((c) => c.kind === kind);
}

export function threadMessages(calls: Recorded[]): string[] {
  return ofKind(calls, "thread.message").map((c) => String(c.detail["body"]));
}

// ---------------------------------------------------------------------------
// Acting as a participant: the buttons the Slack adapter renders, clicked.
// The action ids and values mirror `SlackConversationAdapter.postProposal` /
// `postConfirmation` exactly — that is what Slack echoes back on a click.
// ---------------------------------------------------------------------------

export async function accept(
  stage: Stage,
  who: Party,
  agreementId: string,
  optionId: string,
): Promise<void> {
  const res = await stage.click(who, {
    action_id: `agree:${agreementId}:${optionId}`,
    value: { agreementId, optionId, kind: "accept" },
  });
  if (res.status !== 200) throw new Error(`accept click answered ${res.status}`);
}

export async function suggestAnother(
  stage: Stage,
  who: Party,
  agreementId: string,
): Promise<void> {
  const res = await stage.click(who, {
    action_id: `counter:${agreementId}`,
    value: { agreementId, kind: "counter" },
  });
  if (res.status !== 200) throw new Error(`counter click answered ${res.status}`);
}

/**
 * Fill in the counter modal the system actually opened (the last
 * `views.open` it made) with a wall-clock date and time in the submitter's
 * own zone, and submit it.
 */
export async function submitCounter(
  stage: Stage,
  who: Party,
  wallClock: { date: string; time: string },
): Promise<Response> {
  const opened = ofKind(stage.calls(), "slack.views.open").filter(
    (c) => c.detail["callbackId"] === "counter_proposal",
  );
  const view = opened.at(-1);
  if (!view) throw new Error("no counter modal was opened");
  return stage.submitModal(who, {
    callback_id: "counter_proposal",
    private_metadata: view.detail["privateMetadata"],
    state: {
      values: {
        counter_date: { counter_date_value: { selected_date: wallClock.date } },
        counter_time: { counter_time_value: { selected_time: wallClock.time } },
      },
    },
  });
}

export function lastConfirmationRequest(calls: Recorded[]): { extractionId: string; docUrl: string } {
  const last = ofKind(calls, "thread.confirmation").at(-1);
  if (!last) throw new Error("no confirmation was requested");
  return {
    extractionId: String(last.detail["extractionId"]),
    docUrl: String(last.detail["docUrl"]),
  };
}

export async function verdict(
  stage: Stage,
  who: Party,
  extractionId: string,
  kind: "confirm" | "edit",
): Promise<void> {
  const res = await stage.click(who, {
    action_id: `${kind}_extraction:${extractionId}`,
    value: { extractionId, kind },
  });
  if (res.status !== 200) throw new Error(`${kind} click answered ${res.status}`);
}

export async function say(stage: Stage, who: Party, text: string, options?: { channel?: string; ts?: string }): Promise<void> {
  const res = await stage.say(who, text, options);
  if (res.status !== 200) throw new Error(`message answered ${res.status}`);
}

export function hoursAfter(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}
