import {
  addDays,
  addHours,
  addMinutes,
  hoursBetween,
  nextDueAt,
  proposeSlots,
  renderNamingTemplate,
  resolveAgreement,
  roundsExhausted,
  subjectRef,
  type Effect,
  type PairContext,
  type ProposalOption,
  type Saga,
  type SagaContext,
  type SagaInput,
  type SagaStep,
} from "@mentorship/core";

/**
 * SessionLifecycle — one instance per active pair, looping for the life of the
 * cohort. This single saga covers the whole planner brief:
 *
 *   1. propose a time in a joint thread, book it on agreement
 *   2. remind before the meeting
 *   3. acquire the transcript, extract, project to the shared doc, confirm
 *   4. when the agreed frequency elapses, propose the next one
 *   5. collect feedback from each side, privately
 *
 * Step 4 is not a separate check — it is `cooling` expiring.
 *
 * Only two states are model-driven (`proposing` drafts copy, `extracting` runs
 * the session-intelligence primitive). Everything else is a deterministic
 * transition with an explicit timeout, which is why the whole flow is testable
 * without a model in the loop.
 */

export type SessionLifecycleState =
  | { name: "idle" }
  | {
      name: "proposing";
      agreementId: string;
      round: number;
      firstProposedAt: string;
      renudged: boolean;
    }
  | {
      name: "scheduling";
      optionId: string;
      startsAt: string;
      endsAt: string;
    }
  | {
      name: "armed";
      sessionId: string;
      calendarEventId: string;
      startsAt: string;
      endsAt: string;
      reminderSent: boolean;
    }
  | {
      name: "awaiting_artifact";
      sessionId: string;
      calendarEventId: string;
      endsAt: string;
      attempt: number;
      mode: "polling" | "manual_notes";
    }
  | {
      name: "extracting";
      sessionId: string;
      sourceRef: string;
      stage: "extract" | "render";
      extractionId?: string;
    }
  | {
      name: "confirming";
      sessionId: string;
      extractionId: string;
      docUrl: string;
      verdicts: Record<string, "confirmed" | "edited">;
    }
  | { name: "feedback"; sessionId: string; pending: string[] }
  | { name: "cooling"; lastSessionAt: string }
  | { name: "paused"; reason: string };

export const SESSION_LIFECYCLE = "SessionLifecycle";

const SLOT_COUNT = 3;

function pairingIdFrom(ref: string): string {
  const [, id] = ref.split(":");
  if (!id) throw new Error(`unexpected subjectRef: ${ref}`);
  return id;
}

function participantIds(pair: PairContext): string[] {
  return pair.participants.map((p) => p.participantId);
}

/**
 * The running doc's name. Roles are looked up by the names `policy.roles`
 * uses rather than by position, because a program may define neither
 * "mentor" nor "mentee" — a template that names a role this program does not
 * have keeps its placeholder, which is `renderNamingTemplate`'s documented
 * behaviour and better than an empty title.
 */
function documentTitle(pair: PairContext): string {
  const byRole = (role: string): string | undefined =>
    pair.participants.find((p) => p.role === role)?.displayName;
  const vars: Record<string, string> = { pairTitle: pair.title };
  const mentor = byRole("mentor");
  const mentee = byRole("mentee");
  if (mentor !== undefined) vars["mentorName"] = mentor;
  if (mentee !== undefined) vars["menteeName"] = mentee;
  return renderNamingTemplate(pair.policy.document.namingTemplate, vars);
}

/**
 * Recording consent is separate from AI-processing consent, defaults to off,
 * and needs every party. This is the check that decides whether the saga polls
 * for a transcript at all or goes straight to asking for notes.
 */
function transcriptionPermitted(pair: PairContext): boolean {
  return (
    pair.policy.consent.recording === "opt_in" &&
    pair.participants.every((p) => p.consent.recording)
  );
}

async function buildProposal(
  pair: PairContext,
  ctx: SagaContext,
  preferred: ProposalOption[] = [],
): Promise<{ options: ProposalOption[]; degraded: boolean }> {
  const caps = await ctx.resolve.capabilities("calendar");
  const from = addDays(ctx.now.toISOString(), 1);
  const window = {
    start: from,
    end: addDays(from, pair.cadence.horizonDays),
  };

  let busyByRef: Record<string, { start: string; end: string }[]> = {};
  if (caps?.freeBusy) {
    busyByRef = await ctx.resolve.freeBusy({
      calendarRefs: pair.participants.map((p) => p.calendarRef),
      window,
    });
  }

  const generated = proposeSlots({
    participants: pair.participants.map((p) => ({
      memberRef: p.calendarRef,
      tzOffsetMinutes: p.tzOffsetMinutes,
      busy: busyByRef[p.calendarRef] ?? [],
    })),
    from,
    horizonDays: pair.cadence.horizonDays,
    durationMinutes: pair.cadence.sessionMinutes,
    startHour: pair.cadence.workingHours.startHour,
    endHour: pair.cadence.workingHours.endHour,
    count: Math.max(SLOT_COUNT - preferred.length, 1),
  });

  // A counter-proposal from a human always leads the list.
  const options = [...preferred, ...generated]
    .slice(0, SLOT_COUNT)
    .map((o, i) => ({ ...o, optionId: `opt_${i + 1}` }));

  return { options, degraded: !caps?.freeBusy };
}

function proposalBody(
  pair: PairContext,
  options: ProposalOption[],
  degraded: boolean,
  round: number,
): string {
  const who = pair.participants.map((p) => p.displayName).join(" and ");
  const lead =
    round > 1
      ? `Thanks — trying again with the time that was suggested, plus two alternatives.`
      : `Time for your ${pair.cadence.label} session, ${who}.`;
  const lines = options.map((o, i) => `  ${i + 1}. ${o.label}`);
  const caveat = degraded
    ? "\n\n(Calendar availability isn't connected, so these are working-hours guesses.)"
    : "";
  return `${lead}\n\nPick one, or suggest another:\n${lines.join("\n")}${caveat}`;
}

export function createSessionLifecycle(): Saga<SessionLifecycleState> {
  return {
    name: SESSION_LIFECYCLE,
    initial: () => ({ name: "idle" }),

    async step(
      state: SessionLifecycleState,
      input: SagaInput,
      ctx: SagaContext,
    ): Promise<SagaStep<SessionLifecycleState>> {
      const pairingId = pairingIdFrom(ctx.subjectRef);
      const pair = await ctx.resolve.pairContext(pairingId);
      const now = ctx.now.toISOString();

      // ---------------------------------------------------------------------
      switch (state.name) {
        // -------------------------------------------------------------------
        case "idle": {
          return openProposal(pair, ctx, [], 1, now);
        }

        // -------------------------------------------------------------------
        case "proposing": {
          const agreement = await ctx.resolve.agreement(state.agreementId);
          if (!agreement) {
            return {
              next: { name: "paused", reason: "agreement_missing" },
              done: true,
              effects: [
                {
                  type: "escalate",
                  reason: "agreement_missing",
                  detail: state.agreementId,
                },
              ],
            };
          }

          const resolution = resolveAgreement(
            agreement,
            pair.policy.agreement,
            ctx.now,
          );

          const keepWaiting: SagaStep<SessionLifecycleState> = {
            next: state,
            waitFor: {
              names: ["agreement.responded"],
              subjectRef: subjectRef("agreement", state.agreementId),
            },
            timeoutAt: agreement.timeoutAt,
          };

          switch (resolution.status) {
            case "pending": {
              if (input.kind !== "timeout") return keepWaiting;
              break; // expired-but-pending falls through to the timeout handling
            }

            case "accepted": {
              const option = agreement.options.find(
                (o) => o.optionId === resolution.optionId,
              );
              if (!option) return keepWaiting;
              return book(pair, ctx, option, resolution.unanimous);
            }

            case "countered": {
              if (roundsExhausted(agreement, pair.policy.agreement)) {
                return {
                  next: { name: "paused", reason: "negotiation_exhausted" },
                  done: true,
                  effects: [
                    {
                      type: "post_message",
                      body: "You two seem to want different times — I'll let your program admin help sort this one out.",
                    },
                    {
                      type: "escalate",
                      reason: "negotiation_exhausted",
                      detail: `after ${agreement.round} rounds`,
                    },
                  ],
                };
              }
              return openProposal(
                pair,
                ctx,
                [resolution.counter],
                agreement.round + 1,
                state.firstProposedAt,
              );
            }

            case "conflict": {
              const picked = agreement.options.filter((o) =>
                Object.values(resolution.picks).includes(o.optionId),
              );
              return openProposal(
                pair,
                ctx,
                picked,
                agreement.round + 1,
                state.firstProposedAt,
              );
            }

            case "declined": {
              return {
                next: { name: "paused", reason: "declined" },
                done: true,
                effects: [
                  {
                    type: "escalate",
                    reason: "session_declined",
                    detail: resolution.by,
                  },
                  ],
              };
            }

            case "stalled":
              break;
          }

          // Timeout / stalled handling. Renudge once, then a human — never a
          // third attempt.
          const elapsed = hoursBetween(state.firstProposedAt, now);
          if (
            resolution.status === "stalled" &&
            resolution.reason === "partial_response"
          ) {
            return {
              next: { name: "paused", reason: "one_sided_response" },
              done: true,
              effects: [
                {
                  type: "escalate",
                  reason: "one_sided_response",
                  detail: "one party replied, the other did not",
                },
              ],
            };
          }

          if (elapsed >= pair.policy.agreement.escalateAfterHours) {
            return {
              next: { name: "paused", reason: "no_response" },
              done: true,
              effects: [
                {
                  type: "escalate",
                  reason: "no_response",
                  detail: `${Math.round(elapsed)}h with no reply from either party`,
                },
              ],
            };
          }

          if (!state.renudged) {
            return {
              next: { ...state, renudged: true },
              waitFor: {
                names: ["agreement.responded"],
                subjectRef: subjectRef("agreement", state.agreementId),
              },
              timeoutAt: addHours(now, pair.policy.agreement.renudgeAfterHours),
              effects: [
                {
                  type: "post_message",
                  body: "Nudging gently — any of those times work? Reply with another if not.",
                },
              ],
            };
          }

          return {
            next: { name: "paused", reason: "no_response" },
            done: true,
            effects: [
              {
                type: "escalate",
                reason: "no_response",
                detail: "renudged once, still silent",
              },
            ],
          };
        }

        // -------------------------------------------------------------------
        case "scheduling": {
          if (input.kind === "timeout") {
            return {
              next: { name: "paused", reason: "calendar_never_confirmed" },
              done: true,
              effects: [
                {
                  type: "escalate",
                  reason: "calendar_never_confirmed",
                  detail: "agreed a time but no invite came back",
                },
              ],
            };
          }
          if (input.kind !== "event") return { next: state };

          const sessionId =
            (input.event.payload["sessionId"] as string | undefined) ??
            input.event.id;
          const calendarEventId =
            (input.event.payload["calendarEventId"] as string | undefined) ?? "";
          const reminderAt = addHours(
            state.startsAt,
            -pair.cadence.reminderLeadHours,
          );
          const reminderIsFuture = Date.parse(reminderAt) > Date.parse(now);
          const firstPoll = pair.policy.artifact.pollScheduleMinutes[0] ?? 15;

          return {
            next: {
              name: "armed",
              sessionId,
              calendarEventId,
              startsAt: state.startsAt,
              endsAt: state.endsAt,
              reminderSent: !reminderIsFuture,
            },
            waitFor: {
              names: ["session.cancelled"],
              subjectRef: ctx.subjectRef,
            },
            timeoutAt: reminderIsFuture
              ? reminderAt
              : addMinutes(state.endsAt, firstPoll),
          };
        }

        // -------------------------------------------------------------------
        case "armed": {
          if (input.kind === "event" && input.event.name === "session.cancelled") {
            return openProposal(
              pair,
              ctx,
              [],
              1,
              now,
              "That invite disappeared from the calendar — let's find another time.",
            );
          }

          if (!state.reminderSent) {
            const firstPoll = pair.policy.artifact.pollScheduleMinutes[0] ?? 15;
            return {
              next: { ...state, reminderSent: true },
              waitFor: {
                names: ["session.cancelled"],
                subjectRef: ctx.subjectRef,
              },
              timeoutAt: addMinutes(state.endsAt, firstPoll),
              effects: [
                { type: "verify_calendar_event", eventId: state.calendarEventId },
                {
                  type: "post_message",
                  body: `Reminder: your session is coming up — ${new Date(state.startsAt).toUTCString()}.`,
                },
                ...pair.participants.map(
                  (p): Effect => ({
                    type: "dm",
                    participantId: p.participantId,
                    body: `Heads up: your mentoring session is at ${new Date(state.startsAt).toUTCString()}.`,
                  }),
                ),
                { type: "emit", name: "session.reminded" },
              ],
            };
          }

          // The meeting has ended. Whether we wait for a transcript at all is a
          // capability-and-consent question, not an assumption.
          const transcriptCaps = await ctx.resolve.capabilities("transcript");
          const canTranscribe =
            transcriptCaps?.autoTranscription === "native" &&
            transcriptionPermitted(pair);

          if (!canTranscribe) {
            return {
              next: {
                name: "awaiting_artifact",
                sessionId: state.sessionId,
                calendarEventId: state.calendarEventId,
                endsAt: state.endsAt,
                attempt: 0,
                mode: "manual_notes",
              },
              waitFor: {
                names: ["notes.submitted"],
                subjectRef: ctx.subjectRef,
              },
              timeoutAt: addHours(
                now,
                pair.policy.artifact.manualNotesWindowHours,
              ),
              effects: [
                { type: "emit", name: "session.held" },
                {
                  type: "post_message",
                  body: "How did it go? Drop a few notes here — even three lines is enough for me to pull out the action items.",
                },
              ],
            };
          }

          return {
            next: {
              name: "awaiting_artifact",
              sessionId: state.sessionId,
              calendarEventId: state.calendarEventId,
              endsAt: state.endsAt,
              attempt: 0,
              mode: "polling",
            },
            waitFor: {
              names: ["transcript.available", "notes.submitted"],
              subjectRef: ctx.subjectRef,
            },
            timeoutAt: pollTimeout(pair, state.endsAt, 1, now),
            effects: [
              { type: "emit", name: "session.held" },
              {
                type: "fetch_transcript",
                calendarEventId: state.calendarEventId,
              },
            ],
          };
        }

        // -------------------------------------------------------------------
        case "awaiting_artifact": {
          if (input.kind === "event") {
            const ref =
              (input.event.payload["ref"] as string | undefined) ??
              (input.event.payload["noteId"] as string | undefined) ??
              input.event.id;
            const notesBody = input.event.payload["body"] as string | undefined;
            return {
              next: {
                name: "extracting",
                sessionId: state.sessionId,
                sourceRef: ref,
                stage: "extract",
              },
              waitFor: {
                names: ["extraction.completed"],
                subjectRef: ctx.subjectRef,
              },
              timeoutAt: addHours(now, 6),
              effects: [
                {
                  type: "run_extraction",
                  sessionId: state.sessionId,
                  sourceRef: ref,
                  ...(notesBody !== undefined ? { text: notesBody } : {}),
                },
              ],
            };
          }

          // Timeout.
          if (state.mode === "manual_notes") {
            // Give-up is a designed path, and an undocumented session is a real
            // signal about the pair rather than an error to swallow.
            return {
              next: { name: "cooling", lastSessionAt: state.endsAt },
              ...coolingStep(pair, state.endsAt, now),
              effects: [
                { type: "emit", name: "session.undocumented" },
                {
                  type: "post_message",
                  body: "No notes this time — no problem. I'll line up the next session.",
                },
              ],
            };
          }

          const schedule = pair.policy.artifact.pollScheduleMinutes;
          const nextAttempt = state.attempt + 1;
          if (nextAttempt < schedule.length) {
            return {
              next: { ...state, attempt: nextAttempt },
              waitFor: {
                names: ["transcript.available", "notes.submitted"],
                subjectRef: ctx.subjectRef,
              },
              timeoutAt: pollTimeout(pair, state.endsAt, nextAttempt + 1, now),
              effects: [
                {
                  type: "fetch_transcript",
                  calendarEventId: state.calendarEventId,
                },
              ],
            };
          }

          return {
            next: { ...state, mode: "manual_notes", attempt: nextAttempt },
            waitFor: { names: ["notes.submitted"], subjectRef: ctx.subjectRef },
            timeoutAt: addHours(
              now,
              pair.policy.artifact.manualNotesWindowHours,
            ),
            effects: [
              {
                type: "post_message",
                body: "I couldn't find a transcript for that one. Could either of you drop a few notes here instead?",
              },
            ],
          };
        }

        // -------------------------------------------------------------------
        case "extracting": {
          if (input.kind === "timeout") {
            return {
              next: { name: "cooling", lastSessionAt: now },
              ...coolingStep(pair, now, now),
              effects: [
                {
                  type: "escalate",
                  reason: "extraction_timeout",
                  detail: state.sessionId,
                },
              ],
            };
          }
          if (input.kind !== "event") return { next: state };

          if (state.stage === "extract") {
            const markdown =
              (input.event.payload["markdown"] as string | undefined) ?? "";
            const extractionId =
              (input.event.payload["extractionId"] as string | undefined) ??
              input.event.id;
            return {
              next: { ...state, stage: "render", extractionId },
              waitFor: {
                names: ["document.rendered"],
                subjectRef: ctx.subjectRef,
              },
              timeoutAt: addHours(now, 6),
              effects: [
                {
                  type: "render_document",
                  title: documentTitle(pair),
                  markdown,
                },
              ],
            };
          }

          // stage === 'render'
          const docUrl =
            (input.event.payload["url"] as string | undefined) ?? "(doc)";
          const extractionId = state.extractionId ?? input.event.id;
          return {
            next: {
              name: "confirming",
              sessionId: state.sessionId,
              extractionId,
              docUrl,
              verdicts: {},
            },
            waitFor: {
              names: ["extraction.confirmed", "extraction.edited"],
              subjectRef: ctx.subjectRef,
            },
            timeoutAt: addHours(
              now,
              pair.policy.confirmation.autoConfirmAfterHours,
            ),
            effects: [
              {
                // Buttons, not prose. A typed "looks good" is not a verdict
                // this saga will ever read (invariant 9) — the verdict comes
                // back as `extraction.confirmed` / `extraction.edited` from a
                // structured click.
                type: "request_confirmation",
                extractionId,
                docUrl,
                body: `I've written up the session here: ${docUrl}\n\nLooks right? Confirm below, or open the doc to edit it.`,
              },
            ],
          };
        }

        // -------------------------------------------------------------------
        case "confirming": {
          if (input.kind === "event") {
            const who = input.event.payload["participantId"] as
              | string
              | undefined;
            const verdicts = { ...state.verdicts };
            if (who) {
              verdicts[who] =
                input.event.name === "extraction.edited" ? "edited" : "confirmed";
            }

            const everyone = participantIds(pair).every((p) => p in verdicts);
            if (!everyone) {
              return {
                next: { ...state, verdicts },
                waitFor: {
                  names: ["extraction.confirmed", "extraction.edited"],
                  subjectRef: ctx.subjectRef,
                },
                timeoutAt: addHours(
                  now,
                  pair.policy.confirmation.autoConfirmAfterHours,
                ),
              };
            }
            return enterFeedback(pair, state.sessionId, ctx, now);
          }

          // Auto-confirm on timeout, explicitly flagged. A timeout must never
          // silently promote a machine guess to agreed fact.
          const onward = enterFeedback(pair, state.sessionId, ctx, now);
          return {
            ...onward,
            effects: [
              {
                type: "emit",
                name: "extraction.confirmed",
                payload: { extractionId: state.extractionId, unverified: true },
              },
              {
                type: "render_document",
                title: documentTitle(pair),
                markdown:
                  "> Not reviewed by either participant — treat as unverified.\n",
              },
              ...(onward.effects ?? []),
            ],
          };
        }

        // -------------------------------------------------------------------
        case "feedback": {
          if (input.kind === "event") {
            const who = input.event.payload["participantId"] as
              | string
              | undefined;
            const pending = state.pending.filter((p) => p !== who);
            if (pending.length > 0) {
              return {
                next: { ...state, pending },
                waitFor: {
                  names: ["feedback.submitted"],
                  subjectRef: ctx.subjectRef,
                },
                timeoutAt: addHours(now, pair.policy.feedback.windowHours),
              };
            }
            return {
              next: { name: "cooling", lastSessionAt: now },
              ...coolingStep(pair, now, now),
            };
          }

          return {
            next: { name: "cooling", lastSessionAt: now },
            ...coolingStep(pair, now, now),
            effects: state.pending.map(
              (): Effect => ({ type: "emit", name: "survey.unanswered" }),
            ),
          };
        }

        // -------------------------------------------------------------------
        case "cooling": {
          return openProposal(pair, ctx, [], 1, now, undefined, [
            { type: "emit", name: "pair.cadence_deficit" },
          ]);
        }

        // -------------------------------------------------------------------
        case "paused":
          return { next: state, done: true };
      }
    },
  };

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function pollTimeout(
    pair: PairContext,
    endsAt: string,
    nextIndex: number,
    now: string,
  ): string {
    const schedule = pair.policy.artifact.pollScheduleMinutes;
    const offset = schedule[nextIndex] ?? schedule[schedule.length - 1] ?? 1440;
    const candidate = addMinutes(endsAt, offset);
    return Date.parse(candidate) > Date.parse(now) ? candidate : addMinutes(now, 1);
  }

  async function openProposal(
    pair: PairContext,
    ctx: SagaContext,
    preferred: ProposalOption[],
    round: number,
    firstProposedAt: string,
    preamble?: string,
    extraEffects: Effect[] = [],
  ): Promise<SagaStep<SessionLifecycleState>> {
    const now = ctx.now.toISOString();
    const { options, degraded } = await buildProposal(pair, ctx, preferred);
    const agreementId = ctx.ids.next("agr");

    if (options.length === 0) {
      return {
        next: { name: "paused", reason: "no_mutual_availability" },
        done: true,
        effects: [
          {
            type: "escalate",
            reason: "no_mutual_availability",
            detail: `no common slot in ${pair.cadence.horizonDays} days`,
          },
        ],
      };
    }

    const body =
      (preamble ? `${preamble}\n\n` : "") +
      proposalBody(pair, options, degraded, round);

    return {
      next: {
        name: "proposing",
        agreementId,
        round,
        firstProposedAt,
        renudged: false,
      },
      waitFor: {
        names: ["agreement.responded"],
        subjectRef: subjectRef("agreement", agreementId),
      },
      timeoutAt: addHours(now, pair.policy.agreement.responseTimeoutHours),
      effects: [
        ...extraEffects,
        { type: "ensure_thread", title: pair.title },
        { type: "post_proposal", agreementId, options, body },
        {
          type: "emit",
          name: "agreement.opened",
          payload: {
            agreementId,
            pairingId: pair.pairingId,
            participantIds: participantIds(pair),
            options,
            round,
            timeoutAt: addHours(
              now,
              pair.policy.agreement.responseTimeoutHours,
            ),
          },
        },
        { type: "emit", name: "session.proposed", payload: { agreementId } },
      ],
    };
  }

  function book(
    pair: PairContext,
    ctx: SagaContext,
    option: ProposalOption,
    unanimous: boolean,
  ): SagaStep<SessionLifecycleState> {
    const withTranscription = transcriptionPermitted(pair);
    return {
      // `armed` is entered by the session.scheduled event the runner emits, so
      // the saga never holds a calendar id it did not actually receive.
      next: {
        name: "scheduling",
        optionId: option.optionId,
        startsAt: option.startsAt,
        endsAt: option.endsAt,
      },
      waitFor: { names: ["session.scheduled"], subjectRef: ctx.subjectRef },
      timeoutAt: addHours(ctx.now.toISOString(), 1),
      effects: [
        {
          type: "create_calendar_event",
          start: option.startsAt,
          end: option.endsAt,
          title: pair.title,
          description: [
            `${pair.cadence.label} mentoring session.`,
            withTranscription
              ? "This meeting will be transcribed; both participants have opted in."
              : "This meeting will not be recorded.",
          ].join("\n"),
          withConference: true,
          withTranscription,
        },
        {
          type: "post_message",
          body: `Booked — ${option.label}. Invite is on its way.${
            unanimous ? "" : " (Going ahead on one confirmation.)"
          }`,
        },
      ],
    };
  }

  function enterFeedback(
    pair: PairContext,
    sessionId: string,
    ctx: SagaContext,
    now: string,
  ): SagaStep<SessionLifecycleState> {
    if (!pair.policy.feedback.enabled) {
      return {
        next: { name: "cooling", lastSessionAt: now },
        ...coolingStep(pair, now, now),
      };
    }
    return {
      next: { name: "feedback", sessionId, pending: participantIds(pair) },
      waitFor: { names: ["feedback.submitted"], subjectRef: ctx.subjectRef },
      timeoutAt: addHours(now, pair.policy.feedback.windowHours),
      effects: pair.participants.map(
        (p): Effect => ({
          type: "request_feedback",
          participantId: p.participantId,
          // One question, in a DM. Nobody rates a meeting honestly in front of
          // the other participant.
          question: "Was that session useful? 1–5, and anything you'd change.",
        }),
      ),
    };
  }

  function coolingStep(
    pair: PairContext,
    lastSessionAt: string,
    now: string,
  ): Omit<SagaStep<SessionLifecycleState>, "next"> {
    const due = nextDueAt(lastSessionAt, pair.cadence.everyDays, now);
    if (!due) {
      // Ad-hoc program: no cadence, so nothing to wake up for.
      return { waitFor: null, timeoutAt: null, done: true };
    }
    const wake = addDays(due, -pair.cadence.proposeLeadDays);
    return {
      waitFor: null,
      timeoutAt: Date.parse(wake) > Date.parse(now) ? wake : addMinutes(now, 1),
    };
  }
}
