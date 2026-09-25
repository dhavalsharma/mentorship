import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { LlmProvider, LlmStructuredRequest, LlmUsage, SagaHistoryEntry } from "@mentorship/core";
import { DeterministicProvider } from "@mentorship/ai";
import { sagaInstances } from "@mentorship/db";
import type { TraceLine } from "@mentorship/workflows";
import { runJourney, type Journey } from "./journey.js";
import type { Stage } from "./stage.js";

/**
 * The cross-cutting properties, each a function of a journey and nothing
 * else. None of them knows what the journey is about; that is the point —
 * every journey added is five more assertions for free.
 */

export type PropertyName = "P1" | "P3" | "P4" | "P5";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Ids differ between two runs by construction (fresh org, fresh rows), so
 * each run's ids are renamed to their order of first appearance. What is left
 * to differ is order, content and time — which is exactly what determinism
 * means here. Events are read before calls so the numbering is stable.
 */
export async function normalizedLog(s: Stage): Promise<{ events: unknown[]; calls: unknown[] }> {
  const seen = new Map<string, string>();
  const rename = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value).replace(UUID, (id) => {
        const key = id.toLowerCase();
        if (!seen.has(key)) seen.set(key, `<id${seen.size + 1}>`);
        return seen.get(key)!;
      }),
    );
  const events = (await s.events()).map((e) =>
    rename({ name: e.name, subjectRef: e.subjectRef, payload: e.payload, occurredAt: e.occurredAt }),
  );
  const calls = s.calls().map((c) => rename(c));
  return { events, calls };
}

export async function idsIn(s: Stage): Promise<Set<string>> {
  const text = JSON.stringify([await s.events(), s.calls()]);
  return new Set((text.match(UUID) ?? []).map((id) => id.toLowerCase()));
}

// ---------------------------------------------------------------------------
// P4 · timeout totality (invariant 7)
// ---------------------------------------------------------------------------

/**
 * The one place the suite reads `saga_instances`, and it reads only
 * `history`: "every state entered carried a timeout" is a statement about the
 * saga's own bookkeeping, and no participant-visible surface can witness a
 * wait that has no deadline — it simply never ends. The event log shows what
 * happened; only the history shows what the saga was prepared to wait for.
 *
 * Strict form: a timeout or `done`. A `waitFor` alone is a wait on a human
 * that nothing will ever give up on.
 */
export async function timeoutTotalityViolations(s: Stage): Promise<string[]> {
  const rows = await s.internals.observer.db
    .select({
      id: sagaInstances.id,
      history: sagaInstances.history,
      status: sagaInstances.status,
      timeoutAt: sagaInstances.timeoutAt,
    })
    .from(sagaInstances)
    .where(eq(sagaInstances.orgId, s.orgId));
  const violations: string[] = [];
  for (const row of rows) {
    // The row as it stands, too: an instance created and never advanced has
    // no history at all to be wrong in, and is the most stuck of all.
    if (row.status === "running" && row.timeoutAt === null) {
      violations.push(`instance ${row.id} is running with no timeout (${(row.history as unknown[]).length} steps taken)`);
    }
    for (const entry of row.history as SagaHistoryEntry[]) {
      if (entry.input === "terminal-event") continue;
      if (entry.done === undefined) {
        violations.push(`step ${entry.stepIndex} (${entry.from} -> ${entry.to}) predates wait bookkeeping`);
        continue;
      }
      if (!entry.done && !entry.timeoutAt) {
        violations.push(
          `step ${entry.stepIndex}: ${entry.from} -> ${entry.to} on ${entry.input} waits on ${JSON.stringify(entry.waitFor)} with no timeout and is not done`,
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// P5 · determinism, and the model fence (invariant 8)
// ---------------------------------------------------------------------------

/** A clean, schema-valid extraction with nothing that needs an evidence span. */
export const CLEAN_EXTRACTION = {
  summary: ["The pair discussed next steps."],
  actionItems: [],
  goalProgress: [],
  blockers: [],
  sentimentBand: "neutral",
  riskFlags: [],
  nextSessionPrep: [],
};

/**
 * An `LlmProvider` that refuses any question but the session-intel one. With
 * the trace check below, it proves the model is reachable only through
 * `run_extraction`, and that effect is only ever emitted on entry to
 * `extracting` — invariant 8, enforced end to end rather than by reading
 * `session-lifecycle.ts`.
 */
export class FencedLlm implements LlmProvider {
  readonly model = "fenced";
  readonly questions: string[] = [];
  constructor(private readonly inner: LlmProvider = new DeterministicProvider({ fallbackValue: CLEAN_EXTRACTION })) {}

  async structured<T>(request: LlmStructuredRequest<T>): Promise<{ value: T; usage: LlmUsage }> {
    this.questions.push(request.schemaName);
    if (!request.prompt.includes("BEGIN SESSION RECORD")) {
      throw new Error(`model called outside session intelligence: ${request.schemaName}`);
    }
    return this.inner.structured(request);
  }
}

// ---------------------------------------------------------------------------
// P1 · idempotency under redelivery (invariant 6)
// ---------------------------------------------------------------------------

/**
 * At-least-once delivery, stated as a property: put every event this org has
 * ever relayed back in the outbox and drain. The one write here is a fault
 * injection — the relay's own failure mode (a crash after the effects, before
 * `relayed_at` committed) produced on demand.
 */
export async function redeliverEverything(s: Stage): Promise<void> {
  await s.internals.observer.db.execute(
    sql`update events set relayed_at = null where org_id = ${s.orgId} and dead_lettered_at is null`,
  );
  // Tolerant: a journey that ends wedged (dm-outage) is still wedged after
  // redelivery, and that is not what this property is about.
  await s.drain({ tolerate: true });
}

// ---------------------------------------------------------------------------

/**
 * Product bugs the properties have found, named once so every journey that
 * trips one points at the same explanation. Empty today: the one entry,
 * `redeliveredActivationRestartsPausedSaga` (a redelivered `pair.activated`
 * restarted a paused, `done` SessionLifecycle — `SagaEngine.start()` deduped
 * only running instances), was fixed by deduping against *any* existing
 * instance for the subject, and its four journeys' P1 now run as plain `it`.
 */
export const KNOWN_BUGS = {} as const satisfies Record<string, string>;

/**
 * Registers the gate properties for a journey. `known` marks a property that
 * currently fails because of a named product bug — asserted as `it.fails` so
 * the suite goes red the day the bug is fixed and the marker is stale.
 */
export function describeProperties(
  journey: Journey,
  options: { known?: Partial<Record<PropertyName, string>> } = {},
): void {
  const known = options.known ?? {};
  const test = (name: PropertyName) => (known[name] ? it.fails : it);
  const label = (name: PropertyName, text: string) =>
    known[name] ? `${text} — KNOWN BUG: ${known[name]}` : text;

  describe(`properties: ${journey.name}`, () => {
    test("P4")(label("P4", "P4 every state it entered carried a timeout or was done (invariant 7)"), async () => {
      const s = await runJourney(journey);
      try {
        expect(await timeoutTotalityViolations(s)).toEqual([]);
      } finally {
        await s.close();
      }
    });

    test("P5")(label("P5", "P5 two runs with the same clock produce the same log"), async () => {
      const a = await runJourney(journey);
      const b = await runJourney(journey);
      try {
        const [la, lb] = [await normalizedLog(a), await normalizedLog(b)];
        expect(lb.events).toEqual(la.events);
        expect(lb.calls).toEqual(la.calls);
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("P5")(label("P5", "P5 the model is reachable only from the extracting transition (invariant 8)"), async () => {
      const fenced = new FencedLlm(journey.options?.llm);
      const traces: TraceLine[] = [];
      const s = await runJourney(journey, {
        llm: fenced,
        consents: { ...journey.options?.consents, aiProcessing: true },
        onTrace: (line) => traces.push(line),
      });
      try {
        const extractions = traces.filter((t) => t.effects.includes("run_extraction"));
        expect(extractions.every((t) => t.to === "extracting")).toBe(true);
        expect(fenced.questions).toHaveLength(extractions.length);
        expect(s.logs().filter((l) => l.includes("model called outside"))).toEqual([]);
      } finally {
        await s.close();
      }
    });

    test("P3")(label("P3", "P3 run in two orgs at once, neither sees the other"), async () => {
      const [a, b] = await Promise.all([runJourney(journey), runJourney(journey)]);
      try {
        const [idsA, idsB] = [await idsIn(a), await idsIn(b)];
        expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
        expect(idsA.has(b.orgId)).toBe(false);
        expect(idsB.has(a.orgId)).toBe(false);
        // And running alongside another tenant changed nothing about either.
        const [la, lb] = [await normalizedLog(a), await normalizedLog(b)];
        expect(lb.events).toEqual(la.events);
        expect(lb.calls).toEqual(la.calls);
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("P1")(label("P1", "P1 redelivering every event changes nothing outside (invariant 6)"), async () => {
      const s = await runJourney(journey);
      try {
        const before = await normalizedLog(s);
        await redeliverEverything(s);
        const after = await normalizedLog(s);
        expect(after.calls).toEqual(before.calls);
        expect(after.events).toEqual(before.events);
      } finally {
        await s.close();
      }
    });
  });
}
