import type {
  CalendarAdapter,
  ConversationAdapter,
  DmAdapter,
  DocumentAdapter,
  Effect,
  IdFactory,
  PairContext,
  SagaResolvers,
  ThreadRef,
  TranscriptAdapter,
} from "@mentorship/core";
import { subjectRef, uuidIds } from "@mentorship/core";
import type { EmitInput, EventSink } from "@mentorship/events";
import type { IntegrationRegistry } from "@mentorship/integrations";
import type { EffectContext, EffectRunner } from "./engine.js";

/**
 * The seam where the session-intelligence primitive plugs in. The shipped
 * implementation is deterministic and model-free, which is deliberate: the
 * saga is worth running before any extraction exists, and being able to test
 * the whole flow without a model is what keeps it debuggable.
 */
export interface SessionIntel {
  extract(input: {
    sessionId: string;
    sourceRef: string;
    text: string;
    pair: PairContext;
  }): Promise<{ extractionId: string; markdown: string; actionItems: string[] }>;
}

export interface EffectRunnerOptions {
  registry: IntegrationRegistry;
  log: EventSink;
  resolvers: SagaResolvers;
  intel: SessionIntel;
  ids?: IdFactory;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Translates saga effects into adapter calls, and turns their outcomes back
 * into events. Two rules hold throughout:
 *
 *   - Degradation lives here, not in the saga. An empty slot takes its
 *     documented fallback path rather than failing the step, so the same saga
 *     runs on Slack+Google, on Teams, and on email alone.
 *   - Anything the saga needs back arrives as an event, never as a return
 *     value. That is what lets every effect be retried safely.
 */
export function createEffectRunner(opts: EffectRunnerOptions): EffectRunner {
  const ids = opts.ids ?? uuidIds;
  const threads = new Map<string, ThreadRef>();
  // In production these two live on the `pairings` row and in `session_notes`.
  const docRefs = new Map<string, string>();
  const transcripts = new Map<string, string>();

  const warn = (m: string, d?: Record<string, unknown>) =>
    opts.onWarn?.(m, d);

  const pairingIdOf = (ctx: EffectContext) => {
    const [, id] = ctx.instance.subjectRef.split(":");
    if (!id) throw new Error(`unexpected subjectRef ${ctx.instance.subjectRef}`);
    return id;
  };

  async function thread(
    pair: PairContext,
  ): Promise<{ adapter: ConversationAdapter; ref: ThreadRef } | null> {
    const adapter = opts.registry.get<ConversationAdapter>("conversation");
    if (!adapter) return null;
    const cached = threads.get(pair.pairingId);
    if (cached) return { adapter, ref: cached };
    const ref = await adapter.ensureThread({
      pairingId: pair.pairingId,
      memberRefs: pair.participants.map((p) => p.memberRef),
      title: pair.title,
    });
    threads.set(pair.pairingId, ref);
    return { adapter, ref };
  }

  /** Joint-thread messages degrade to a DM to each party; never the reverse. */
  async function broadcast(
    pair: PairContext,
    body: string,
    key: string,
  ): Promise<void> {
    const t = await thread(pair);
    if (t) {
      await t.adapter.postMessage({ thread: t.ref, body, idempotencyKey: key });
      return;
    }
    const dm = opts.registry.get<DmAdapter>("dm");
    if (!dm) {
      warn("no conversation or dm adapter bound; message dropped", { body });
      return;
    }
    for (const [i, p] of pair.participants.entries()) {
      await dm.send({
        memberRef: p.memberRef,
        body,
        idempotencyKey: `${key}:${i}`,
      });
    }
  }

  return async function runEffect(effect: Effect, ctx: EffectContext) {
    const pairingId = pairingIdOf(ctx);
    const pair = await opts.resolvers.pairContext(pairingId);
    const emit = (
      name: EmitInput["name"],
      payload?: Record<string, unknown>,
      subject?: string,
    ) =>
      opts.log.emit({
        orgId: ctx.instance.orgId,
        name,
        subjectRef: subject ?? ctx.instance.subjectRef,
        payload,
      });

    switch (effect.type) {
      case "ensure_thread": {
        const t = await thread(pair);
        if (!t) warn("conversation slot empty; using in-app thread fallback");
        return t?.ref ?? null;
      }

      case "post_proposal": {
        const t = await thread(pair);
        if (!t) {
          await broadcast(pair, effect.body, ctx.key);
          return null;
        }
        const caps = await opts.registry.capabilities("conversation");
        if (!caps?.interactiveApproval) {
          // Without buttons we still post, but the interaction handler must
          // collect structured replies some other way — we never parse "yes"
          // out of prose to decide that a meeting was agreed.
          warn("conversation adapter has no interactive approval", {
            adapter: t.adapter.id,
          });
        }
        return t.adapter.postProposal({
          thread: t.ref,
          agreementId: effect.agreementId,
          options: effect.options,
          body: effect.body,
          idempotencyKey: ctx.key,
        });
      }

      case "post_message": {
        await broadcast(pair, effect.body, ctx.key);
        return null;
      }

      case "dm": {
        const dm = opts.registry.get<DmAdapter>("dm");
        const participant = pair.participants.find(
          (p) => p.participantId === effect.participantId,
        );
        if (!participant) return null;
        if (!dm) {
          // Deliberately NOT falling back to the joint thread: a private
          // message that lands in front of the other participant is worse
          // than one that is not sent.
          warn("dm slot empty; private message not sent", {
            participantId: effect.participantId,
          });
          return null;
        }
        return dm.send({
          memberRef: participant.memberRef,
          body: effect.body,
          idempotencyKey: ctx.key,
        });
      }

      case "create_calendar_event": {
        const calendar = opts.registry.get<CalendarAdapter>("calendar");
        const sessionId = ids.next("ses");

        if (!calendar) {
          warn("calendar slot empty; asking the pair to create the invite");
          await broadcast(
            pair,
            `Agreed for ${effect.start}. Could one of you send the invite? I'll take it from here.`,
            `${ctx.key}:manual-invite`,
          );
          await emit("session.scheduled", {
            sessionId,
            calendarEventId: "",
            startsAt: effect.start,
            endsAt: effect.end,
            transcriptionEnabled: false,
            degraded: true,
          });
          return { sessionId };
        }

        const event = await calendar.createEvent({
          memberRefs: pair.participants.map((p) => p.calendarRef),
          start: effect.start,
          end: effect.end,
          title: effect.title,
          description: effect.description,
          withConference: effect.withConference,
          withTranscription: effect.withTranscription,
          idempotencyKey: ctx.key,
        });
        await emit("session.scheduled", {
          sessionId,
          calendarEventId: event.eventId,
          startsAt: effect.start,
          endsAt: effect.end,
          conferenceUrl: event.conferenceUrl ?? null,
          transcriptionEnabled: event.transcriptionEnabled,
        });
        return { sessionId, calendarEventId: event.eventId };
      }

      case "verify_calendar_event": {
        const calendar = opts.registry.get<CalendarAdapter>("calendar");
        if (!calendar || !effect.eventId) return null;
        const found = await calendar.getEvent(effect.eventId);
        if (!found) {
          await emit("session.cancelled", { calendarEventId: effect.eventId });
        }
        return { present: Boolean(found) };
      }

      case "fetch_transcript": {
        const adapter = opts.registry.get<TranscriptAdapter>("transcript");
        if (!adapter) return null;
        const found = await adapter.fetch({
          calendarEventId: effect.calendarEventId,
        });
        if (!found) return { found: false };
        transcripts.set(found.ref, found.text);
        await emit("transcript.available", { ref: found.ref });
        return { found: true, ref: found.ref };
      }

      case "run_extraction": {
        const text = effect.text ?? transcripts.get(effect.sourceRef) ?? "";
        const result = await opts.intel.extract({
          sessionId: effect.sessionId,
          sourceRef: effect.sourceRef,
          text,
          pair,
        });
        await emit("extraction.completed", {
          extractionId: result.extractionId,
          markdown: result.markdown,
          actionItems: result.actionItems,
          sourceRef: effect.sourceRef,
        });
        return { extractionId: result.extractionId };
      }

      case "render_document": {
        const adapter = opts.registry.get<DocumentAdapter>("document");
        if (!adapter) {
          // Same projection model, internal surface.
          const url = `/orgs/${pair.orgId}/pairs/${pair.pairingId}/notes`;
          await emit("document.rendered", { url, degraded: true });
          return { url };
        }
        const rendered = await adapter.renderManagedRegion({
          docRef: docRefs.get(pair.pairingId) ?? pair.documentRef ?? null,
          title: effect.title,
          markdown: effect.markdown,
          idempotencyKey: ctx.key,
        });
        docRefs.set(pair.pairingId, rendered.docRef);
        await emit("document.rendered", {
          url: rendered.url,
          docRef: rendered.docRef,
          revisionId: rendered.revisionId,
        });
        return rendered;
      }

      case "request_feedback": {
        const dm = opts.registry.get<DmAdapter>("dm");
        const participant = pair.participants.find(
          (p) => p.participantId === effect.participantId,
        );
        if (!dm || !participant) {
          warn("feedback not requested: dm slot empty", {
            participantId: effect.participantId,
          });
          return null;
        }
        return dm.send({
          memberRef: participant.memberRef,
          body: effect.question,
          idempotencyKey: ctx.key,
        });
      }

      case "emit": {
        const event = await emit(
          effect.name,
          effect.payload,
          effect.subjectRef ??
            (effect.payload?.["agreementId"]
              ? subjectRef("agreement", String(effect.payload["agreementId"]))
              : undefined),
        );
        return { eventId: event.id };
      }

      case "escalate": {
        warn(`escalated: ${effect.reason}`, { detail: effect.detail });
        await emit("saga.escalated", {
          reason: effect.reason,
          detail: effect.detail ?? null,
          pairingId: pair.pairingId,
        });
        return null;
      }
    }
  };
}

/**
 * Model-free extraction. It finds explicit commitments by cue phrase and
 * writes the same markdown shape a real extraction produces, so the document
 * projection, the confirm step and the tests are all exercised end to end.
 *
 * Replace with a schema-bound model call — and keep the evidence spans, which
 * are what make an extracted claim checkable rather than believable.
 */
export function heuristicSessionIntel(ids: IdFactory = uuidIds): SessionIntel {
  const CUES = [
    /\bI'?ll\b/i,
    /\bI will\b/i,
    /\bsend me\b/i,
    /\blet'?s make\b/i,
    /\bby (?:friday|monday|next week|then)\b/i,
    /\bwrite it up\b/i,
  ];

  return {
    async extract({ sessionId, sourceRef, text, pair }) {
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const actionItems: string[] = [];
      for (const [index, line] of lines.entries()) {
        if (CUES.some((c) => c.test(line))) {
          const speaker = line.includes(":") ? line.split(":")[0]!.trim() : "—";
          const said = line.includes(":")
            ? line.slice(line.indexOf(":") + 1).trim()
            : line;
          // The evidence span is the point: every claim points back to an
          // exact location in the unedited source.
          actionItems.push(`${speaker}: ${said}  _(line ${index + 1})_`);
        }
      }

      const markdown = [
        `## Session summary`,
        ``,
        lines.length === 0
          ? `_No notes or transcript were available for this session._`
          : `- ${lines.length} exchanges captured from \`${sourceRef}\``,
        ``,
        `## Action items`,
        ``,
        actionItems.length > 0
          ? actionItems.map((a) => `- [ ] ${a}`).join("\n")
          : `_None detected — confirm or add below._`,
        ``,
        `## Pair`,
        ``,
        pair.participants
          .map((p) => `- ${p.displayName} (${p.role})`)
          .join("\n"),
        ``,
        `_Extracted automatically and not yet reviewed. Confirm in the thread._`,
      ].join("\n");

      return {
        extractionId: ids.next("ext"),
        markdown,
        actionItems,
        sessionId,
      } as { extractionId: string; markdown: string; actionItems: string[] };
    },
  };
}
