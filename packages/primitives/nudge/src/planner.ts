import { z } from "zod";
import type { EvidenceSpan, Primitive } from "@mentorship/core";
import { structuredWithRepair } from "@mentorship/ai";
import { ThompsonBandit, type Rng, type TemplateBandit } from "./bandit.js";
import {
  NudgeDecisionSchema,
  NudgeLimitsSchema,
  type GateResult,
  type NudgeContext,
  type NudgeDecision,
  type NudgePairView,
  type NudgePlan,
  type NudgeReader,
  type NudgeRecipient,
} from "./context.js";
import type { Deficit } from "./deficits.js";
import { applyGates } from "./gates.js";
import { NUDGE_PLAN_PROMPT, nudgePrompts } from "./prompts.js";
import {
  NudgeChannelSchema,
  NudgeToneSchema,
  templateById,
  templatesFor,
  toneForAttempt,
  toneRank,
  type NudgeTone,
  type NudgeVars,
} from "./templates.js";

/**
 * The nudge planner: the only inferred step in the whole engine.
 *
 * A cron job that mails a template produces notification fatigue in about
 * three weeks, and the channel never recovers. So the engine is
 *
 *     expectation contract → absence detector → planner → gate chain
 *
 * and only the third box is allowed to be a model. It decides *whether* a
 * message is worth sending, *which party* to address, the channel, the rung on
 * the escalation ladder and the copy. Everything that protects the user's
 * attention — dedupe, rate limits, quiet hours, mute — happens after it, in
 * code, and can veto it (see `gates.ts`).
 *
 * The ladder ceiling is deterministic too: invariant 11 is "renudge once, then
 * escalate", and that is not a thing to leave to a persuasive prompt.
 */

/** What the model is asked for. Deliberately smaller than `NudgeDecision`. */
export const NudgePlanDraftSchema = z.object({
  shouldNudge: z.boolean(),
  recipientParticipantId: z.string(),
  templateId: z.string(),
  channel: NudgeChannelSchema,
  tone: NudgeToneSchema,
  body: z.string(),
  rationale: z.string(),
  /**
   * Quotes, not offsets. The model is bad at arithmetic and this is a number
   * that affects what a human is shown, so we locate the spans ourselves
   * (invariants 17 and 18).
   */
  evidenceQuotes: z.array(z.string()).optional(),
});
export type NudgePlanDraft = z.infer<typeof NudgePlanDraftSchema>;

export interface NudgePlannerOptions {
  /** Injectable and seedable, so a cohort's choices can be replayed. */
  bandit?: TemplateBandit;
  rng?: Rng;
  limits?: z.input<typeof NudgeLimitsSchema>;
  /**
   * Defaults to the deficit's own `occurredAt`. The sweep instant is the right
   * clock for gating: it is what the deficit was true at, and it makes a
   * planner run reproducible from the event log alone.
   */
  clock?: () => string;
}

const ESCALATION_ROLE = "program_admin";

export function createNudgePlanner(
  options: NudgePlannerOptions = {},
): Primitive<Deficit, NudgeContext, NudgeDecision, NudgeReader> {
  const bandit = options.bandit ?? new ThompsonBandit(options.rng);
  const limits = NudgeLimitsSchema.parse(options.limits ?? {});

  return {
    name: "nudge.planner",
    promptVersion: NUDGE_PLAN_PROMPT,
    outputSchema: NudgeDecisionSchema,

    async resolve(deficit, reader) {
      const now = options.clock ? options.clock() : deficit.occurredAt;
      const [pair, history, stats] = await Promise.all([
        reader.pair(deficit.pairingId),
        reader.history({
          pairingId: deficit.pairingId,
          subjectRef: deficit.subjectRef,
          deficit: deficit.name,
        }),
        reader.templateStats({ orgId: deficit.orgId, deficit: deficit.name }),
      ]);

      // A pair-level deficit is about the pair; everything else is about a
      // thing with a participant-authored name.
      const subjectLabel = deficit.subjectRef.startsWith("pairing:")
        ? pair.title
        : await reader.subjectLabel(deficit.subjectRef);

      // Deliveries, not attempts: a nudge the gate chain dropped was never
      // heard, so it must not consume a rung of the ladder.
      const tone = toneForAttempt(history.delivered.length);
      const ranked = bandit.rank(
        templatesFor(deficit.name, tone).map((t) => t.id),
        stats,
      );

      const context: NudgeContext = {
        now,
        deficit,
        pair,
        history,
        subjectLabel,
        dedupeKey: deficit.dedupeKey,
        tone,
        ranked,
        defaultRecipientId: defaultRecipient(deficit, pair)?.participantId ?? null,
        limits,
        sourceText: "",
      };
      context.sourceText = renderFacts(context);
      return context;
    },

    async infer(ctx, llm) {
      // The ladder has run out: there is nothing left to say to the pair, and
      // the model is not consulted about whether to give up. Saves a call and,
      // more importantly, removes the temptation to argue with invariant 11.
      if (ctx.tone === "admin") return escalationDecision(ctx, "ladder exhausted");

      const rendered = nudgePrompts.render(NUDGE_PLAN_PROMPT, {
        facts: ctx.sourceText,
        candidates: ctx.ranked
          .map((r, i) => `${i + 1}. ${r.templateId}`)
          .join("\n"),
        tone: ctx.tone,
        channels: channelsFor(ctx).join(", ") || "none",
      });

      const { value: draft } = await structuredWithRepair(llm, {
        ...(rendered.system ? { system: rendered.system } : {}),
        prompt: rendered.prompt,
        schema: NudgePlanDraftSchema,
        schemaName: "NudgePlanDraft",
      });

      const plan = clampDraft(draft, ctx);
      return finalise(ctx, plan, {
        hold: !draft.shouldNudge,
        holdReason: draft.rationale,
      });
    },

    /**
     * The deterministic answer. A reminder platform whose reminders stop when
     * a vendor is down is not degraded, it is broken — so this is a real plan,
     * not a placeholder: the bandit's best arm, addressed to the party the
     * facts point at, on the private channel.
     */
    fallback(ctx) {
      if (ctx.tone === "admin") return escalationDecision(ctx, "ladder exhausted");

      const recipient = recipientById(ctx.pair, ctx.defaultRecipientId);
      const templateId =
        ctx.ranked[0]?.templateId ?? templatesFor(ctx.deficit.name, ctx.tone)[0]?.id ?? "";

      const plan: NudgePlan = {
        recipientParticipantId: recipient?.participantId ?? null,
        recipientRole: recipient?.role ?? ESCALATION_ROLE,
        channel: "dm",
        tone: ctx.tone,
        templateId,
        body: renderBody(ctx, templateId, recipient),
        rationale: recipient
          ? `deterministic: ${describeBlocker(ctx, recipient)}`
          : "deterministic: no addressable participant",
        evidence: [firstLineSpan(ctx.sourceText)],
      };
      return finalise(ctx, plan, { hold: false });
    },

    /**
     * `auto` when every gate passed, because a reminder that needs a human to
     * approve it is a reminder the human could have sent. `escalate` is the
     * one that leaves the queue and reaches a named person.
     *
     * Policy is unused: there is no nudge-autonomy field in `ProgramPolicy`
     * yet, and adding one means editing `packages/core`. When it lands, a
     * program that wants nudges reviewed returns "approve" here.
     */
    gate(out) {
      if (out.outcome === "escalate") return "escalate";
      if (out.outcome === "send") return "auto";
      return "log";
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function recipientById(
  pair: NudgePairView,
  participantId: string | null,
): NudgeRecipient | null {
  if (!participantId) return null;
  return pair.recipients.find((r) => r.participantId === participantId) ?? null;
}

/**
 * Who the absence belongs to, decided without a model:
 *   1. whoever the deficit already names (the action item's owner, the party
 *      an open agreement is waiting on) — this is a fact, not a guess;
 *   2. otherwise the least recently responsive participant, because silence is
 *      the only blocker signal we have;
 *   3. otherwise the first participant.
 */
export function defaultRecipient(
  deficit: Deficit,
  pair: NudgePairView,
): NudgeRecipient | null {
  const named = recipientById(pair, deficit.blockedOnParticipantId);
  if (named) return named;
  const ranked = [...pair.recipients].sort((a, b) => {
    const at = a.lastRespondedAt ? Date.parse(a.lastRespondedAt) : 0;
    const bt = b.lastRespondedAt ? Date.parse(b.lastRespondedAt) : 0;
    return at - bt || a.participantId.localeCompare(b.participantId);
  });
  return ranked[0] ?? null;
}

function describeBlocker(ctx: NudgeContext, recipient: NudgeRecipient): string {
  if (ctx.deficit.blockedOnParticipantId === recipient.participantId) {
    return `${recipient.displayName} is the party the pair is waiting on`;
  }
  return recipient.lastRespondedAt
    ? `${recipient.displayName} has been quiet the longest`
    : `${recipient.displayName} has not responded at all`;
}

function channelsFor(ctx: NudgeContext): string[] {
  const all = new Set<string>();
  for (const r of ctx.pair.recipients) for (const c of r.channels) all.add(c);
  return [...all].sort();
}

function varsFor(ctx: NudgeContext, recipient: NudgeRecipient | null): NudgeVars {
  const other = ctx.pair.recipients.find(
    (r) => r.participantId !== recipient?.participantId,
  );
  return {
    recipientName: recipient?.displayName ?? "there",
    otherName: other?.displayName ?? "your partner",
    pairTitle: ctx.pair.title,
    overdueDays: ctx.deficit.overdueDays,
    cadenceLabel: ctx.pair.cadenceLabel,
    subjectLabel: ctx.subjectLabel,
  };
}

export function renderBody(
  ctx: NudgeContext,
  templateId: string,
  recipient: NudgeRecipient | null,
): string {
  const template = templateById(templateId);
  if (template) return template.render(varsFor(ctx, recipient));
  // A template id that does not exist is a bug upstream, not a reason to send
  // nothing: the rung's first template is always a safe thing to say.
  const first = templatesFor(ctx.deficit.name, ctx.tone)[0];
  if (first) return first.render(varsFor(ctx, recipient));
  return `Checking in on ${ctx.pair.title}.`;
}

/**
 * The facts block. One fact per line, so an evidence span lands on something
 * a human can read back. Nothing here is instruction-shaped, and the only
 * participant-authored string in it — the subject label — is quoted and
 * labelled as such.
 */
export function renderFacts(ctx: NudgeContext): string {
  const d = ctx.deficit;
  const lines: string[] = [
    `DEFICIT ${d.name} severity=${d.severity} overdue_days=${d.overdueDays}`,
    `PAIR ${ctx.pair.title} on a ${ctx.pair.cadenceLabel} cadence`,
  ];
  if (!d.subjectRef.startsWith("pairing:")) {
    lines.push(`SUBJECT (participant-written label) "${ctx.subjectLabel}"`);
  }
  for (const [key, value] of Object.entries(d.detail)) {
    lines.push(`FACT ${key}=${value === null ? "none" : String(value)}`);
  }
  for (const r of ctx.pair.recipients) {
    lines.push(
      `PARTICIPANT id=${r.participantId} role=${r.role} name=${r.displayName} ` +
        `last_replied=${r.lastRespondedAt ?? "never"} nudges_last_7_days=${r.nudgesLast7Days}`,
    );
  }
  if (d.blockedOnParticipantId) {
    lines.push(`WAITING_ON id=${d.blockedOnParticipantId}`);
  }
  lines.push(
    `HISTORY delivered=${ctx.history.delivered.length} consecutive_drops=${ctx.history.consecutiveDrops}`,
  );
  for (const sent of ctx.history.delivered) {
    lines.push(
      `PREVIOUS sent_at=${sent.sentAt} tone=${sent.tone} template=${sent.templateId} ` +
        `worked=${sent.bookedWithin7Days === null ? "unknown" : sent.bookedWithin7Days}`,
    );
  }
  return lines.join("\n");
}

/** Spans into the facts block. A quote that is not there earns no span. */
export function spansFor(quotes: string[], source: string): EvidenceSpan[] {
  const out: EvidenceSpan[] = [];
  for (const quote of quotes) {
    const trimmed = quote.trim();
    if (!trimmed) continue;
    const start = source.indexOf(trimmed);
    if (start < 0) continue;
    out.push({ start, end: start + trimmed.length, quote: trimmed });
  }
  return out;
}

function firstLineSpan(source: string): EvidenceSpan {
  const newline = source.indexOf("\n");
  const end = newline < 0 ? source.length : newline;
  return { start: 0, end, quote: source.slice(0, end) };
}

/**
 * Everything the model is allowed to be wrong about, made safe. Note what is
 * *not* clamped: the channel. A planner that keeps addressing one person on
 * the joint thread is a quality bug, and silently rewriting it to a DM hides
 * that bug — the privacy gate drops the message and logs why, which is loud.
 */
export function clampDraft(draft: NudgePlanDraft, ctx: NudgeContext): NudgePlan {
  const tone: NudgeTone =
    toneRank(draft.tone) > toneRank(ctx.tone) ? ctx.tone : draft.tone;

  const allowed = templatesFor(ctx.deficit.name, tone).map((t) => t.id);
  const preferred = ctx.ranked.find((r) => allowed.includes(r.templateId));
  const templateId = allowed.includes(draft.templateId)
    ? draft.templateId
    : preferred?.templateId ?? allowed[0] ?? "";

  const recipient =
    recipientById(ctx.pair, draft.recipientParticipantId) ??
    recipientById(ctx.pair, ctx.defaultRecipientId);

  const trimmed = draft.body.trim();
  const usable = trimmed.length > 0 && trimmed.length <= ctx.limits.maxBodyChars;
  const evidence = spansFor(draft.evidenceQuotes ?? [], ctx.sourceText);

  return {
    recipientParticipantId: recipient?.participantId ?? null,
    recipientRole: recipient?.role ?? ESCALATION_ROLE,
    channel: draft.channel,
    tone,
    templateId,
    body: usable ? trimmed : renderBody(ctx, templateId, recipient),
    rationale: draft.rationale,
    // An inferred output with no checkable evidence is a claim; the deficit
    // line is at least a true one.
    evidence: evidence.length > 0 ? evidence : [firstLineSpan(ctx.sourceText)],
  };
}

/**
 * Run the gate chain and turn a plan into a decision. Shared by `infer` and
 * `fallback` so that a degraded run is filtered by exactly the same rules —
 * the day the model is down is not the day to send at 3am.
 */
export function finalise(
  ctx: NudgeContext,
  plan: NudgePlan,
  opts: { hold: boolean; holdReason?: string },
): NudgeDecision {
  const base = {
    deficit: ctx.deficit.name,
    pairingId: ctx.deficit.pairingId,
    subjectRef: ctx.deficit.subjectRef,
    dedupeKey: ctx.dedupeKey,
    plan,
  };

  const recipient = recipientById(ctx.pair, plan.recipientParticipantId);
  if (!recipient) {
    return NudgeDecisionSchema.parse({
      ...base,
      outcome: "drop",
      gates: [],
      dropReason: "no addressable participant on this pair",
      event: "nudge.suppressed",
      nextEligibleAt: null,
    });
  }

  const gates = applyGates({ plan, ctx, recipient });

  // A deliberate hold is not a failed delivery: it does not count toward the
  // consecutive-drop escalation, because nothing went wrong.
  if (opts.hold) {
    return NudgeDecisionSchema.parse({
      ...base,
      outcome: "drop",
      gates: gates.results,
      dropReason: `planner held: ${opts.holdReason ?? "a message now would not help"}`,
      event: "nudge.suppressed",
      nextEligibleAt: gates.nextEligibleAt,
    });
  }

  if (gates.blocked) {
    const drops = ctx.history.consecutiveDrops + 1;
    if (drops >= ctx.limits.dropsBeforeEscalation) {
      // Three drops in a row is not bad luck, it is a channel that does not
      // work. Telling a human beats trying a fourth time.
      return escalationDecision(
        ctx,
        `${drops} consecutive drops, last: ${gates.blocked.reason ?? gates.blocked.gate}`,
        gates.results,
      );
    }
    return NudgeDecisionSchema.parse({
      ...base,
      outcome: "drop",
      gates: gates.results,
      dropReason: gates.blocked.reason ?? gates.blocked.gate,
      // Mute gets its own event because "they told us to stop" and "we chose
      // not to" are different facts, and only one of them is a product bug.
      event: gates.blocked.gate === "mute" ? "nudge.muted" : "nudge.suppressed",
      nextEligibleAt: gates.nextEligibleAt,
    });
  }

  return NudgeDecisionSchema.parse({
    ...base,
    outcome: "send",
    gates: gates.results,
    dropReason: null,
    // `nudge.planned`, not `nudge.sent`: only the adapter that actually
    // delivered the message may claim that, and it may still fail.
    event: "nudge.planned",
    nextEligibleAt: null,
  });
}

/**
 * The top of the ladder. No gate chain: the gates protect the pair's
 * attention, and an escalation is a handover to the person whose job is
 * precisely to receive it. It is also the only outcome that returns the
 * `escalate` gate decision, which bypasses every queue.
 */
export function escalationDecision(
  ctx: NudgeContext,
  reason: string,
  gates: GateResult[] = [],
): NudgeDecision {
  const templateId =
    templatesFor(ctx.deficit.name, "admin")[0]?.id ?? ctx.ranked[0]?.templateId ?? "";
  return NudgeDecisionSchema.parse({
    deficit: ctx.deficit.name,
    pairingId: ctx.deficit.pairingId,
    subjectRef: ctx.deficit.subjectRef,
    dedupeKey: ctx.dedupeKey,
    outcome: "escalate",
    plan: {
      // Null, not the admin's id: an escalation is addressed to whoever the
      // program has on call, and that routing is the saga's to own.
      recipientParticipantId: null,
      recipientRole: ESCALATION_ROLE,
      channel: "dm",
      tone: "admin",
      templateId,
      body: renderBody({ ...ctx, tone: "admin" }, templateId, null),
      rationale: reason,
      evidence: [firstLineSpan(ctx.sourceText)],
    },
    gates,
    dropReason: null,
    event: "saga.escalated",
    nextEligibleAt: null,
  });
}
