import type { DomainEvent, EventName, EventPattern } from "./events.js";
import type { IdFactory } from "./ids.js";
import type { SagaResolvers } from "./resolvers.js";

/**
 * An "agent" in this system is a durable saga. A primitive answers one question
 * in one pass; a planner that proposes a time, waits for two humans, handles one
 * agreeing while the other counters, handles silence, and only then books, is a
 * long-running workflow with waits and timeouts that has to survive a deploy.
 */

export type SagaInput =
  | { kind: "start"; payload?: Record<string, unknown> }
  | { kind: "event"; event: DomainEvent }
  | { kind: "timeout"; at: string };

/**
 * Effects are descriptors, not calls. The engine executes them through the
 * integration registry with an idempotency key, which is what stops a retried
 * step from booking a second calendar invite.
 */
export type Effect =
  | { type: "ensure_thread"; title: string }
  | {
      type: "post_proposal";
      agreementId: string;
      options: { optionId: string; startsAt: string; endsAt: string; label: string }[];
      body: string;
      /**
       * Set when the program lets pairs choose their own length and rhythm:
       * the adapter adds a control that opens that choice. Carried on the
       * proposal because it is the one message every pair reliably sees.
       */
      preferencesPairingId?: string;
    }
  | { type: "post_message"; body: string }
  /**
   * Prompts for the human verdict on an extraction. Distinct from
   * `post_message` because the verdict must come back off a button, not out of
   * prose — see `ConversationAdapter.postConfirmation`.
   */
  | {
      type: "request_confirmation";
      extractionId: string;
      docUrl: string;
      body: string;
    }
  | { type: "dm"; participantId: string; body: string }
  | {
      type: "create_calendar_event";
      start: string;
      end: string;
      title: string;
      description: string;
      withConference: boolean;
      withTranscription: boolean;
    }
  | { type: "verify_calendar_event"; eventId: string }
  | { type: "fetch_transcript"; calendarEventId: string }
  | {
      type: "run_extraction";
      sessionId: string;
      sourceRef: string;
      /**
       * Notes arrive inline on the event that ends `awaiting_artifact` — there
       * is no adapter to fetch them back from, unlike a transcript. Carried
       * here rather than re-read from the log, so the effect stays a
       * self-contained descriptor (invariant 4).
       */
      text?: string;
    }
  /**
   * Invariant 16: reaches the policy-configured safeguarding contact out of
   * band. Never routed through `render_document` / `request_confirmation` —
   * those post into the pair's own thread, exactly where a safeguarding
   * disclosure must not surface.
   */
  | {
      type: "notify_safeguarding";
      sessionId: string;
      extractionId: string;
      summary: string;
    }
  | { type: "render_document"; title: string; markdown: string }
  | { type: "request_feedback"; participantId: string; question: string }
  | {
      type: "emit";
      name: EventName;
      payload?: Record<string, unknown>;
      /** Defaults to the instance's own subject. */
      subjectRef?: string;
    }
  | { type: "escalate"; reason: string; detail?: string };

export interface SagaStep<S> {
  next: S;
  /** Advance when a matching event arrives… */
  waitFor?: EventPattern | null;
  /** …or when this timer fires, whichever comes first. */
  timeoutAt?: string | null;
  effects?: Effect[];
  /** Set when the instance is finished and should stop being scheduled. */
  done?: boolean;
}

export interface SagaContext {
  orgId: string;
  /** What this instance is about, e.g. `pairing:p_001`. */
  subjectRef: string;
  now: Date;
  /** Read-only deterministic queries. Sagas never call adapters directly. */
  resolve: SagaResolvers;
  ids: IdFactory;
  /** Effect keys already executed on this instance, for debugging. */
  effectResults: Record<string, unknown>;
}

export interface Saga<S> {
  readonly name: string;
  readonly initial: (payload?: Record<string, unknown>) => S;
  step(state: S, input: SagaInput, ctx: SagaContext): Promise<SagaStep<S>> | SagaStep<S>;
}

export interface SagaInstance<S = unknown> {
  id: string;
  orgId: string;
  sagaName: string;
  subjectRef: string;
  state: S;
  awaitingEvent: EventPattern | null;
  timeoutAt: string | null;
  /** Optimistic concurrency: a stale write is rejected, not silently merged. */
  version: number;
  stepIndex: number;
  /** Effect keys already executed, so a retry is a no-op. */
  completedEffects: Record<string, unknown>;
  history: SagaHistoryEntry[];
  status: "running" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface SagaHistoryEntry {
  at: string;
  stepIndex: number;
  input: string;
  from: string;
  to: string;
  effects: string[];
  note?: string;
}

/** A readable state name for history and debugging. */
export function stateName(state: unknown): string {
  if (state && typeof state === "object" && "name" in state) {
    return String((state as { name: unknown }).name);
  }
  return "unknown";
}
