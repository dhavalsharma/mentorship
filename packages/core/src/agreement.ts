import { z } from "zod";
import type { ProposalOption } from "./capabilities.js";
import type { AgreementPolicy } from "./policy.js";

/**
 * "If they agree" hides a small state machine with more than two outcomes.
 * This is deliberately pure and deterministic: an inferred "I think they
 * agreed", parsed out of free text, will eventually book a meeting nobody
 * consented to. The model's only job upstream is drafting the message and
 * choosing which slots are worth offering.
 */

export const ResponseKindSchema = z.enum(["accept", "counter", "decline"]);
export type ResponseKind = z.infer<typeof ResponseKindSchema>;

export interface AgreementResponse {
  participantId: string;
  kind: ResponseKind;
  /** Set for `accept`. */
  optionId?: string;
  /** Set for `counter`. */
  counter?: ProposalOption;
  at: string;
}

export interface Agreement {
  id: string;
  subject: "session_time";
  pairingId: string;
  participantIds: string[];
  options: ProposalOption[];
  responses: AgreementResponse[];
  round: number;
  openedAt: string;
  timeoutAt: string;
}

export type Resolution =
  | { status: "pending"; awaiting: string[] }
  | { status: "accepted"; optionId: string; unanimous: boolean }
  | { status: "countered"; by: string; counter: ProposalOption }
  | { status: "conflict"; picks: Record<string, string> }
  | { status: "declined"; by: string }
  | { status: "stalled"; reason: "no_response" | "partial_response" };

/** Last response per participant wins — people change their minds in threads. */
export function latestResponses(
  agreement: Agreement,
): Map<string, AgreementResponse> {
  const byParticipant = new Map<string, AgreementResponse>();
  for (const r of agreement.responses) {
    const existing = byParticipant.get(r.participantId);
    if (!existing || r.at >= existing.at) byParticipant.set(r.participantId, r);
  }
  return byParticipant;
}

export function recordResponse(
  agreement: Agreement,
  response: AgreementResponse,
): Agreement {
  if (!agreement.participantIds.includes(response.participantId)) {
    throw new Error(
      `${response.participantId} is not a party to agreement ${agreement.id}`,
    );
  }
  if (
    response.kind === "accept" &&
    !agreement.options.some((o) => o.optionId === response.optionId)
  ) {
    throw new Error(`unknown option ${response.optionId}`);
  }
  return { ...agreement, responses: [...agreement.responses, response] };
}

export function resolveAgreement(
  agreement: Agreement,
  policy: AgreementPolicy,
  now: Date,
): Resolution {
  const latest = latestResponses(agreement);
  const all = [...latest.values()];

  // A decline ends it outright, whatever anyone else said.
  const declined = all.find((r) => r.kind === "decline");
  if (declined) return { status: "declined", by: declined.participantId };

  // A counter opens a new round. Earliest counter wins so the outcome does not
  // depend on map iteration order.
  const counters = all
    .filter((r) => r.kind === "counter" && r.counter)
    .sort((a, b) => a.at.localeCompare(b.at));
  const firstCounter = counters[0];
  if (firstCounter?.counter) {
    return {
      status: "countered",
      by: firstCounter.participantId,
      counter: firstCounter.counter,
    };
  }

  const accepts = all.filter(
    (r): r is AgreementResponse & { optionId: string } =>
      r.kind === "accept" && typeof r.optionId === "string",
  );
  const picks: Record<string, string> = {};
  for (const a of accepts) picks[a.participantId] = a.optionId;
  const distinct = new Set(accepts.map((a) => a.optionId));

  const everyoneResponded = agreement.participantIds.every((p) =>
    latest.has(p),
  );

  if (everyoneResponded && accepts.length === agreement.participantIds.length) {
    const only = [...distinct][0];
    if (distinct.size === 1 && only) {
      return { status: "accepted", optionId: only, unanimous: true };
    }
    // Both said yes, to different slots. Re-propose the intersection rather
    // than silently picking one.
    return { status: "conflict", picks };
  }

  const expired = now.getTime() >= new Date(agreement.timeoutAt).getTime();
  if (!expired) {
    return {
      status: "pending",
      awaiting: agreement.participantIds.filter((p) => !latest.has(p)),
    };
  }

  if (accepts.length === 0) {
    return { status: "stalled", reason: "no_response" };
  }

  if (policy.resolution === "proceed_on_one") {
    const only = [...distinct][0];
    if (distinct.size === 1 && only) {
      return { status: "accepted", optionId: only, unanimous: false };
    }
    return { status: "conflict", picks };
  }

  return { status: "stalled", reason: "partial_response" };
}

/** Rounds are capped so a negotiation cannot become a nuisance. */
export function roundsExhausted(
  agreement: Agreement,
  policy: AgreementPolicy,
): boolean {
  return agreement.round >= policy.maxRounds;
}
