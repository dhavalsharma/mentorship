import type {
  CalendarAdapter,
  ConversationAdapter,
  DmAdapter,
  DocumentAdapter,
  DomainEvent,
  Effect,
  IdFactory,
  PairContext,
  SagaResolvers,
  SessionSourceStore,
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
  }): Promise<{
    extractionId: string;
    markdown: string;
    actionItems: string[];
    /** Invariant 16: true routes straight to `notify_safeguarding`, never through render/confirm. */
    safeguarding?: boolean;
  }>;
}

/**
 * Step retries a failing DM gets before it degrades to "not sent, escalated".
 * One, in the spirit of invariant 11 — see `sendPrivate` below. Must stay
 * below the engine's `maxStepAttempts`, or the saga parks before it degrades.
 */
export const DM_RETRIES = 1;

type EffectEmit = (
  name: EmitInput["name"],
  payload?: Record<string, unknown>,
  subject?: string,
  part?: string,
) => Promise<DomainEvent>;

export interface EffectRunnerOptions {
  registry: IntegrationRegistry;
  log: EventSink;
  resolvers: SagaResolvers;
  /**
   * Durable home of fetched transcript text (e2e bug #9) — required, not
   * defaulted to a map, because a default is exactly the process memory
   * that lost the transcript across a restart.
   */
  sources: SessionSourceStore;
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
  // In production this lives on the `pairings` row.
  const docRefs = new Map<string, string>();

  const warn = (m: string, d?: Record<string, unknown>) =>
    opts.onWarn?.(m, d);

  const pairingIdOf = (ctx: EffectContext) => {
    const [, id] = ctx.instance.subjectRef.split(":");
    if (!id) throw new Error(`unexpected subjectRef ${ctx.instance.subjectRef}`);
    return id;
  };

  async function thread(
    pair: PairContext,
  ): Promise<{
    adapter: ConversationAdapter;
    ref: ThreadRef;
    /** False when this runner had already resolved the thread for this pair. */
    fresh: boolean;
  } | null> {
    const adapter = opts.registry.get<ConversationAdapter>("conversation");
    if (!adapter) return null;
    const cached = threads.get(pair.pairingId);
    if (cached) return { adapter, ref: cached, fresh: false };
    const ref = await adapter.ensureThread({
      pairingId: pair.pairingId,
      memberRefs: pair.participants.map((p) => p.memberRef),
      title: pair.title,
    });
    threads.set(pair.pairingId, ref);
    return { adapter, ref, fresh: true };
  }

  /**
   * Joint-thread messages degrade to a DM to each party; never the reverse.
   *
   * `part` distinguishes a second shared message inside one effect (the
   * manual-invite request) from the effect's own; the thread post and each
   * recipient's DM are keyed under it exactly as before.
   *
   * With no thread, the *shared* message goes to each participant through a
   * `dm` slot that may be failing rather than absent, and it follows the same
   * one policy `sendPrivate` does (`DM_RETRIES`, `ctx.attempt`), per
   * recipient:
   *
   *   - Every recipient is tried on every attempt, so one failing DM never
   *     holds back the other's message. A recipient who got it is marked in
   *     the step's ledger (`ctx.parts`), and a retry skips them: the Slack DM
   *     adapter has no server-side dedupe, so without this a retry would
   *     re-send to the one it already reached.
   *   - A failure on the first attempt fails the step (a blip is a blip).
   *     From the retry on, each still-failing recipient is warned about and
   *     escalated as `dm_undeliverable`, and the step completes.
   *
   * When *every* recipient fails on the retry, the step still completes —
   * decided deliberately. The alternatives are to keep throwing until the
   * engine parks the instance, or to end the saga. Parking leaves a pair
   * that nothing will ever move again (there is no un-park action), and it
   * reaches a human only through the generic `saga_step_failed`, five
   * backed-off attempts later. Continuing puts a human on it now — one
   * `dm_undeliverable` per recipient, on the retry — while the saga's own
   * deadlines keep running: a proposal nobody saw gets its one renudge
   * (which reaches them if the outage has ended) and then escalates as
   * silence, never a third attempt (invariant 11). What it never does is
   * treat the undelivered message as seen: no agreement is inferred from it
   * (invariant 9), and the wait is the same wait a delivered one gets.
   *
   * There is no thread here to fall back to, so invariant 13 is not in play
   * — but a DM failure never reroutes anywhere else either.
   */
  async function broadcast(
    pair: PairContext,
    body: string,
    ctx: EffectContext,
    emit: EffectEmit,
    part?: string,
  ): Promise<void> {
    const key = part ? `${ctx.key}:${part}` : ctx.key;
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
    const failed: {
      participant: PairContext["participants"][number];
      recipient: string;
      error: unknown;
    }[] = [];
    for (const [i, p] of pair.participants.entries()) {
      const recipient = part ? `${part}:${i}` : String(i);
      if (ctx.parts?.done(recipient)) continue;
      try {
        await dm.send({
          memberRef: p.memberRef,
          body,
          idempotencyKey: `${key}:${i}`,
        });
        ctx.parts?.mark(recipient);
      } catch (error) {
        failed.push({ participant: p, recipient, error });
      }
    }
    if (failed.length === 0) return;
    if (ctx.attempt < DM_RETRIES) throw failed[0]!.error;
    const reachedNobody = failed.length === pair.participants.length;
    for (const { participant, recipient, error } of failed) {
      const message = error instanceof Error ? error.message : String(error);
      warn("dm failed after retry; shared message not sent to participant", {
        participantId: participant.participantId,
        attempt: ctx.attempt,
        reachedNobody,
        error: message,
      });
      await emit(
        "saga.escalated",
        {
          reason: "dm_undeliverable",
          detail: `shared message (no thread) to participant ${participant.participantId}: ${message}`.slice(0, 500),
          pairingId: pair.pairingId,
          participantId: participant.participantId,
        },
        undefined,
        recipient,
      );
    }
  }

  /**
   * A private message to one participant, through a bound `dm` slot that may
   * be *failing* rather than absent.
   *
   * What a persistently failing DM does to the flow, deliberately:
   *
   *   1. The first failure propagates. The engine records it on the instance
   *      (keeping the ledger, so the step's shared post is not repeated),
   *      backs the timer off and retries the step — a blip is a blip.
   *   2. From the retry on (`ctx.attempt >= DM_RETRIES`), a failure degrades:
   *      the message is not sent, an operator is warned, and a human is told
   *      via `saga.escalated` that a private message could not be delivered.
   *      The step then completes and the session carries on.
   *
   * Why degrade rather than keep retrying until the engine parks the saga:
   * every private message in the lifecycle rides a step that also moves the
   * pair on (the reminder step is also what arms `held`; the feedback request
   * rides the confirming step). Parking the whole pairing because a courtesy
   * DM cannot be delivered starves the session of everything that *can* still
   * happen — the thread, the notes, the extraction — and a "heads up, your
   * session is soon" delivered after the session is worse than none. It is
   * "renudge once, then escalate" (invariant 11) applied to a vendor.
   *
   * What it never does, at any attempt: fall back to the joint thread
   * (invariant 13). A private message that lands in front of the other
   * participant is worse than one that is not sent.
   */
  async function sendPrivate(
    dm: DmAdapter,
    participant: PairContext["participants"][number],
    body: string,
    ctx: EffectContext,
    emit: (
      name: EmitInput["name"],
      payload?: Record<string, unknown>,
    ) => Promise<unknown>,
    purpose: "dm" | "request_feedback",
  ): Promise<unknown> {
    try {
      return await dm.send({
        memberRef: participant.memberRef,
        body,
        idempotencyKey: ctx.key,
      });
    } catch (error) {
      if (ctx.attempt < DM_RETRIES) throw error;
      const message = error instanceof Error ? error.message : String(error);
      warn("dm failed after retry; private message not sent", {
        purpose,
        participantId: participant.participantId,
        attempt: ctx.attempt,
        error: message,
      });
      await emit("saga.escalated", {
        reason: "dm_undeliverable",
        detail: `${purpose} to participant ${participant.participantId}: ${message}`.slice(0, 500),
        pairingId: pairingIdOf(ctx),
        participantId: participant.participantId,
      });
      return { delivered: false, error: message };
    }
  }

  return async function runEffect(effect: Effect, ctx: EffectContext) {
    const pairingId = pairingIdOf(ctx);
    const pair = await opts.resolvers.pairContext(pairingId);
    // Every event an effect produces is keyed by that effect (invariant 6).
    // The ledger alone cannot make these idempotent: it is saved with the
    // step, after every effect ran, so a crash between an emit committing and
    // the step saving re-runs the effect on retry. The adapter calls dedupe on
    // `ctx.key`; this is the same key for the event log, and the sink turns a
    // repeat into "here is the event you already appended". The name is part
    // of the key so an effect may emit more than one kind of event.
    //
    // Rejected: writing the step's events in the same transaction as the saga
    // save (buffer here, flush in `store.save`). It closes the window for
    // events, but the engine, store and sink are three separate ports today,
    // the in-memory `Dispatcher` would need the same unit of work, and effects
    // that read an emitted event's id back (`emit` returns `eventId`) would
    // need a deferred id. It also would not remove the need for a key: the
    // adapter call before it is still re-run on retry and still dedupes by
    // key, so the key is the one mechanism that already covers every effect.
    // `part` keys one of several events of the same name from one effect —
    // a fan-out escalating per recipient.
    const emit: EffectEmit = (name, payload, subject, part) =>
      opts.log.emit({
        orgId: ctx.instance.orgId,
        name,
        subjectRef: subject ?? ctx.instance.subjectRef,
        payload,
        idempotencyKey: part ? `${ctx.key}:${part}:${name}` : `${ctx.key}:${name}`,
      });

    switch (effect.type) {
      case "ensure_thread": {
        const t = await thread(pair);
        if (!t) {
          warn("conversation slot empty; using in-app thread fallback");
          return null;
        }
        // The channel id is the only handle an inbound message carries back to
        // this pair, so it is announced rather than kept in this runner's
        // memory: the projection puts it on the pairing, and the Slack events
        // endpoint reads it from there. Announced once per resolution rather
        // than once per proposal round — a fresh process re-announces, which
        // is how the binding survives a deploy that lost this cache.
        if (!t.fresh) return t.ref;
        await emit("pair.thread_bound", {
          adapterId: t.ref.adapterId,
          channelId: t.ref.channelId,
          threadId: t.ref.threadId,
          url: t.ref.url ?? null,
        });
        return t.ref;
      }

      case "post_proposal": {
        const t = await thread(pair);
        if (!t) {
          await broadcast(pair, effect.body, ctx, emit);
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
          ...(effect.preferencesPairingId && caps?.interactiveApproval
            ? { preferencesPairingId: effect.preferencesPairingId }
            : {}),
        });
      }

      case "post_message": {
        await broadcast(pair, effect.body, ctx, emit);
        return null;
      }

      case "request_confirmation": {
        const t = await thread(pair);
        if (!t) {
          // Degraded, and honestly so: without a thread there are no buttons,
          // and the verdict will have to arrive some other structured way or
          // not at all. The timeout in `confirming` still fires and still
          // marks the result unverified (invariant 19).
          await broadcast(pair, effect.body, ctx, emit);
          return null;
        }
        const caps = await opts.registry.capabilities("conversation");
        if (!caps?.interactiveApproval) {
          warn("conversation adapter has no interactive approval", {
            adapter: t.adapter.id,
            extractionId: effect.extractionId,
          });
        }
        return t.adapter.postConfirmation({
          thread: t.ref,
          extractionId: effect.extractionId,
          docUrl: effect.docUrl,
          body: effect.body,
          idempotencyKey: ctx.key,
        });
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
        return sendPrivate(dm, participant, effect.body, ctx, emit, "dm");
      }

      case "create_calendar_event": {
        const calendar = opts.registry.get<CalendarAdapter>("calendar");
        const sessionId = ids.next("ses");

        if (!calendar) {
          warn("calendar slot empty; asking the pair to create the invite");
          await broadcast(
            pair,
            `Agreed for ${effect.start}. Could one of you send the invite? I'll take it from here.`,
            ctx,
            emit,
            "manual-invite",
          );
          const scheduled = await emit("session.scheduled", {
            sessionId,
            calendarEventId: "",
            startsAt: effect.start,
            endsAt: effect.end,
            transcriptionEnabled: false,
            degraded: true,
          });
          return { sessionId: String(scheduled.payload["sessionId"] ?? sessionId) };
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
        // On a retry the sink returns the event the first attempt appended,
        // whose `sessionId` is the one the saga and the projection already
        // know — not the fresh one minted above.
        const scheduled = await emit("session.scheduled", {
          sessionId,
          calendarEventId: event.eventId,
          startsAt: effect.start,
          endsAt: effect.end,
          conferenceUrl: event.conferenceUrl ?? null,
          transcriptionEnabled: event.transcriptionEnabled,
        });
        return {
          sessionId: String(scheduled.payload["sessionId"] ?? sessionId),
          calendarEventId: event.eventId,
        };
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
        // Durable before announced: the extraction runs when the relay
        // delivers `transcript.available`, on a later pass and possibly in a
        // different process. The event carries the reference only.
        if (effect.sessionId) {
          await opts.sources.recordTranscript({
            sessionId: effect.sessionId,
            ref: found.ref,
            body: found.text,
          });
        } else {
          // A step decided before `sessionId` was on this effect, replayed
          // from its pending record. Nothing to key the row on.
          warn("fetch_transcript without a sessionId; transcript not stored", {
            calendarEventId: effect.calendarEventId,
          });
        }
        await emit("transcript.available", { ref: found.ref });
        return { found: true, ref: found.ref };
      }

      case "run_extraction": {
        let text = effect.text;
        if (text === undefined) {
          const stored = await opts.sources.transcript({
            sessionId: effect.sessionId,
            ref: effect.sourceRef,
          });
          if (stored === null) {
            warn("no stored source for extraction; extracting from nothing", {
              sessionId: effect.sessionId,
              sourceRef: effect.sourceRef,
            });
          }
          text = stored ?? "";
        }
        const result = await opts.intel.extract({
          sessionId: effect.sessionId,
          sourceRef: effect.sourceRef,
          text,
          pair,
        });
        const completed = await emit("extraction.completed", {
          extractionId: result.extractionId,
          markdown: result.markdown,
          actionItems: result.actionItems,
          sourceRef: effect.sourceRef,
          ...(result.safeguarding ? { safeguarding: true } : {}),
        });
        return {
          extractionId: String(
            completed.payload["extractionId"] ?? result.extractionId,
          ),
        };
      }

      case "notify_safeguarding": {
        const contact = pair.policy.safeguarding.contactMemberRef;
        const dm = opts.registry.get<DmAdapter>("dm");
        if (!contact || !dm) {
          // Invariant 16 leaves no queue or batch to fall back to — an
          // unconfigured or unbound destination is a loud operational
          // warning, never a silently dropped disclosure.
          warn("safeguarding flagged with no contact configured; not delivered", {
            sessionId: effect.sessionId,
            extractionId: effect.extractionId,
          });
          return { notified: false };
        }
        await dm.send({
          memberRef: contact,
          body: `Safeguarding flag raised on session ${effect.sessionId} (${pair.title}). Review immediately:\n\n${effect.summary}`,
          idempotencyKey: ctx.key,
        });
        return { notified: true };
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
          collaborators: pair.participants.map((p) => ({ email: p.email })),
          idempotencyKey: ctx.key,
        });
        docRefs.set(pair.pairingId, rendered.docRef);
        await emit("document.rendered", {
          url: rendered.url,
          docRef: rendered.docRef,
          revisionId: rendered.revisionId,
          // ADR-0005: a human edit was detected inside the managed region and
          // preserved instead of overwritten — the block the saga just asked
          // to render did not actually change.
          pinned: rendered.pinned,
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
        return sendPrivate(
          dm,
          participant,
          effect.question,
          ctx,
          emit,
          "request_feedback",
        );
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
 *
 * It emits **no risk flags, ever, including `safeguarding`** — deliberately,
 * the same call `packages/primitives/session-intel/src/fallback.ts` makes
 * for the model-degraded path (see that file's doc comment for the full
 * argument): a cue-phrase regex cannot tell a disclosure from someone
 * quoting one, and `safeguarding` wakes a named human out of band
 * (invariant 16) — a regex does not get to make that call. This is why the
 * `extracting` saga state still routes every extraction through
 * render/confirm when this path is used: the degraded write-up lands in
 * front of a human either way, which is the actual safety net here, not
 * keyword matching. Any tenant that needs real safeguarding *detection* —
 * not just eventual human visibility — must configure an `llm` (see
 * `createWorker`/`bootstrap()`); this stub is a floor, not a substitute.
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
