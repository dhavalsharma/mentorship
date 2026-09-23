import { runJourney, type Journey } from "./journey.js";
import { stage, type Stage } from "./stage.js";

/**
 * P2 · crash resume. For every adapter call the uninterrupted run makes, run
 * the journey again with the worker process dying at that call — once before
 * the vendor sees it, once after the vendor acted but before the worker heard
 * back — restart it, and finish. What the outside world saw, and what the log
 * records, must be the same as if nothing had happened.
 *
 * "Dying" is literal: the adapter call never returns, and the worker's pool
 * is ended under it, so Postgres rolls back whatever transaction it held
 * (the relay's claim, with its row lock). A thrown exception would not do —
 * the relay catches those and records an attempt, which is a different and
 * much kinder failure than a process that simply stops.
 *
 * The comparison is deliberately coarser than P5's, in two ways:
 *   - it is a multiset, with every id reduced to `<id>` and every instant
 *     to the minute: a restarted run reads the clock a different number of
 *     times and mints ids in a different order, and neither is a bug;
 *   - repeated `pair.thread_bound` announcements are collapsed. A fresh
 *     process re-announces its thread on first use by design (effects.ts,
 *     `ensure_thread`: "how the binding survives a deploy"), and the
 *     projection is last-writer-wins with the same value.
 * What it still catches is the whole point: a duplicated invite, a second
 * message, a re-emitted event, or an effect that never happened.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

const scrub = (value: unknown): string =>
  JSON.stringify(value)
    .replace(UUID, "<id>")
    .replace(ISO, (t) => t.slice(0, 16));

const READS = new Set(["transcript.fetch"]);

export interface Outcome {
  events: string[];
  calls: string[];
}

export async function outcome(s: Stage): Promise<Outcome> {
  // Order is not compared (see above), so occurrence time adds nothing that
  // the payload's own instants do not already carry.
  const events = (await s.events()).map((e) =>
    scrub({ name: e.name, subjectRef: e.subjectRef, payload: e.payload }),
  );
  const bound = new Set<string>();
  const collapsed = events.filter((e) => {
    if (!e.startsWith('{"name":"pair.thread_bound"')) return true;
    if (bound.has(e)) return false;
    bound.add(e);
    return true;
  });
  return {
    events: collapsed.sort(),
    // Reads may repeat after a crash — re-fetching a transcript nobody saw
    // arrive is the correct recovery, not a duplicate. P2 is about effects.
    calls: s
      .calls()
      .filter((c) => !READS.has(c.kind))
      .map((c) => scrub({ kind: c.kind, detail: c.detail }))
      .sort(),
  };
}

/** What one side has that the other lacks, counted. */
export function difference(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const [ca, cb] = [count(a), count(b)];
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [x, n] of ca) for (let i = cb.get(x) ?? 0; i < n; i++) missing.push(x);
  for (const [x, n] of cb) for (let i = ca.get(x) ?? 0; i < n; i++) extra.push(x);
  return { missing, extra };
}

export interface CrashFinding {
  atCall: number;
  mode: "before" | "after";
  /** The script could not finish — e.g. it waited for a proposal that never came. */
  error?: string;
  /** Distinct event names the crashed run ended with. */
  reached: string[];
  events: { missing: string[]; extra: string[] };
  calls: { missing: string[]; extra: string[] };
}

export async function crashResume(
  journey: Journey,
): Promise<{ adapterCalls: number; expected: Outcome; findings: CrashFinding[] }> {
  const baseline = await runJourney(journey);
  const adapterCalls = baseline.internals.crash.calls;
  const expected = await outcome(baseline);
  await baseline.close();

  const findings: CrashFinding[] = [];
  for (let atCall = 1; atCall <= adapterCalls; atCall++) {
    for (const mode of ["before", "after"] as const) {
      const s = await stage({ ...journey.options, crash: { atCall, mode } });
      let error: string | undefined;
      try {
        await journey.script(s);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      try {
        const got = await outcome(s);
        const events = difference(expected.events, got.events);
        const calls = difference(expected.calls, got.calls);
        const differs =
          events.missing.length + events.extra.length + calls.missing.length + calls.extra.length > 0;
        if (error !== undefined || differs) {
          const reached = [...new Set((await s.events()).map((e) => e.name))];
          findings.push({ atCall, mode, ...(error !== undefined ? { error } : {}), reached, events, calls });
        }
      } finally {
        await s.close();
      }
    }
  }
  return { adapterCalls, expected, findings };
}

/**
 * The graceful version: no crash, but a fresh worker process before every
 * pass, as a deploy landing between any two passes would give. Anything a
 * worker keeps only in memory from one pass to the next shows up here.
 */
export async function restartEveryPass(
  journey: Journey,
): Promise<{ expected: Outcome; finding: CrashFinding | null }> {
  const baseline = await runJourney(journey);
  const expected = await outcome(baseline);
  await baseline.close();

  const s = await stage({ ...journey.options, restartBetweenPasses: true });
  let error: string | undefined;
  try {
    await journey.script(s);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  try {
    const got = await outcome(s);
    const events = difference(expected.events, got.events);
    const calls = difference(expected.calls, got.calls);
    const differs =
      events.missing.length + events.extra.length + calls.missing.length + calls.extra.length > 0;
    if (error === undefined && !differs) return { expected, finding: null };
    const reached = [...new Set((await s.events()).map((e) => e.name))];
    return {
      expected,
      finding: { atCall: 0, mode: "before", ...(error !== undefined ? { error } : {}), reached, events, calls },
    };
  } finally {
    await s.close();
  }
}

// ---------------------------------------------------------------------------
// Known P2 bugs, by signature. Each is a real product defect (see the report
// in docs/e2e-testing-strategy.md); the nightly suite asserts nothing *else*
// shows up, and keeps each known one as an `it.fails` so it goes red — and
// the marker has to be removed — the day it is fixed.
// ---------------------------------------------------------------------------

const parsed = (entry: string): Record<string, unknown> => JSON.parse(entry) as Record<string, unknown>;
const nameOf = (entry: string): string => String(parsed(entry)["name"] ?? parsed(entry)["kind"]);
/** Something that should have happened did not, and nothing happened twice. */
const lostOnly = (f: CrashFinding): boolean =>
  f.events.extra.length === 0 &&
  f.calls.extra.length === 0 &&
  (f.error !== undefined || f.events.missing.length + f.calls.missing.length > 0);

export const P2_KNOWN_BUGS = {
  /**
   * `SagaEngine.start()` commits the new instance (`store.create`) *before*
   * the first `advance` runs its effects and saves. A crash in between leaves
   * a `running` instance in `idle` with no wait and no timeout; the
   * redelivered `pair.activated` finds it "running" and returns it untouched.
   * The pair is never proposed to (or never escalated, for a pair with no
   * mutual hours), and nothing will ever say so — invariant 7, in production.
   * Signature: work lost, nothing duplicated, and what is missing includes
   * the first step's own output.
   */
  strandedAtStart: (f: CrashFinding): boolean =>
    lostOnly(f) &&
    (f.error === "no agreement has been opened" ||
      f.events.missing.some((e) => {
        const p = parsed(e)["payload"] as Record<string, unknown>;
        return (
          (nameOf(e) === "agreement.opened" && p["round"] === 1) ||
          (nameOf(e) === "saga.escalated" && p["reason"] === "no_mutual_availability")
        );
      })),

  /**
   * A step's completed-effect ledger is saved only when the whole step saves,
   * and an `emit` — or a runner emit inside an effect, like
   * `session.scheduled` after `createEvent` — is its own committed write with
   * no idempotency key. A crash after it and before the step saves re-runs
   * it on retry: the adapter call dedupes on its key, the event does not
   * (invariant 6 covers every effect, not only the ones that reach a vendor).
   * Seen as duplicate `session.scheduled` (and with it a phantom `sessions`
   * row), `session.held`, `pair.cadence_deficit`.
   */
  reEmittedOnRetry: (f: CrashFinding, expected?: Outcome): boolean =>
    f.error === undefined &&
    f.events.missing.length === 0 &&
    f.calls.missing.length === 0 &&
    f.calls.extra.length === 0 &&
    f.events.extra.length > 0 &&
    (expected === undefined || f.events.extra.every((e) => expected.events.includes(e))),

  /**
   * The same early emit, with a worse consequence. `confirming`'s timeout
   * step emits `extraction.confirmed {unverified}` *first*, then renders and
   * requests feedback. Crash after the emit: the step never saved, so the
   * instance is still in `confirming` — and still waiting on
   * `extraction.confirmed`. The relay delivers the saga's own auto-confirm to
   * it as if a participant had clicked; with no `participantId` it counts as
   * nobody's verdict, re-arms a fresh 120h timeout, and the render and the
   * feedback requests silently do not happen.
   */
  timeoutStepConsumesItsOwnEvent: (f: CrashFinding): boolean =>
    lostOnly(f) &&
    f.error === undefined &&
    [...f.events.missing, ...f.calls.missing].every((e) =>
      ["document.rendered", "dm.sent"].includes(nameOf(e)),
    ),

  /**
   * `fetch_transcript` keeps the transcript text in the effect runner's
   * memory (`transcripts` in effects.ts — "in production these live on …
   * `session_notes`", which they do not yet) and emits only its ref. The
   * extraction runs when the relay delivers `transcript.available`, which is
   * the *next* pass. A worker restarted in between extracts from an empty
   * string: the write-up says no transcript was available, for a session
   * that was transcribed.
   */
  transcriptLostOnRestart: (f: CrashFinding): boolean =>
    f.error === undefined &&
    f.events.extra.some(
      (e) =>
        nameOf(e) === "extraction.completed" &&
        String((parsed(e)["payload"] as Record<string, unknown>)["markdown"]).includes(
          "No notes or transcript were available",
        ),
    ),

  /**
   * `render_document` on a pair's first render has no doc id to update, and
   * neither `FakeDocument` nor `GoogleDriveDocumentAdapter` uses the
   * idempotency key when *creating* the doc. A crash after the vendor created
   * it and before `document.rendered` committed makes the retry create a
   * second shared doc (in Drive: a second file, and a second access email).
   */
  secondDocumentCreated: (f: CrashFinding): boolean =>
    f.error === undefined &&
    f.calls.extra.some((c) => nameOf(c) === "document.rendered") &&
    [...f.events.missing, ...f.events.extra].every((e) =>
      ["document.rendered", "session.held"].includes(nameOf(e)),
    ),
} as const;

export function explain(f: CrashFinding, expected?: Outcome): keyof typeof P2_KNOWN_BUGS | null {
  for (const [name, matches] of Object.entries(P2_KNOWN_BUGS)) {
    if (matches(f, expected)) return name as keyof typeof P2_KNOWN_BUGS;
  }
  return null;
}
