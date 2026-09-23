import { afterAll, describe, expect, it } from "vitest";
import {
  crashResume,
  explain,
  P2_KNOWN_BUGS,
  restartEveryPass,
  type CrashFinding,
} from "../harness/crash.js";
import type { Journey } from "../harness/journey.js";
import { conflict } from "../journeys/conflict.js";
import { counterThenCap } from "../journeys/counter-then-cap.js";
import { dmOutage } from "../journeys/dm-outage.js";
import { documentEcho, documentPinned } from "../journeys/document-pinned.js";
import { extractionTimeout } from "../journeys/extraction-timeout.js";
import { happyPath } from "../journeys/happy-path.js";
import { noMutualAvailability } from "../journeys/no-mutual-availability.js";
import { noResponse } from "../journeys/no-response.js";
import {
  noTranscription,
  transcribed,
  transcriptionWithoutConsent,
} from "../journeys/no-transcription.js";
import { notesInbound, proseIsNeverAVerdict, strangerNotes } from "../journeys/notes.js";
import { oneSided } from "../journeys/one-sided.js";
import { safeguarding, safeguardingUnconfigured } from "../journeys/safeguarding.js";

/**
 * P2 across the whole catalogue. Nightly only (`pnpm test:e2e:nightly`): it
 * is two full runs per adapter call per journey.
 *
 * Two kinds of assertion. Per journey: every divergence a crash causes is one
 * of the named, known bugs in `P2_KNOWN_BUGS` — anything else is new, and
 * fails. Then per known bug: `it.fails` that it no longer occurs anywhere, so
 * fixing one turns the suite red until its marker is removed.
 */
const JOURNEYS: Journey[] = [
  happyPath,
  noResponse,
  oneSided,
  counterThenCap,
  conflict,
  noMutualAvailability,
  noTranscription,
  transcriptionWithoutConsent,
  transcribed,
  notesInbound,
  strangerNotes,
  proseIsNeverAVerdict,
  extractionTimeout,
  safeguarding,
  safeguardingUnconfigured,
  dmOutage,
  documentPinned,
  documentEcho,
];

const known = new Map<string, { journey: string; atCall: number; mode: string }[]>();

const summarize = (f: CrashFinding): string =>
  JSON.stringify({
    atCall: f.atCall,
    mode: f.mode,
    error: f.error,
    reached: f.reached,
    events: f.events,
    calls: f.calls,
  });

describe("P2 · crash resume", () => {
  // The nightly log is where someone reads this: say which journeys, at which
  // calls, still reproduce each known bug.
  afterAll(() => {
    for (const [bug, hits] of known) {
      const byJourney = new Map<string, string[]>();
      for (const h of hits) {
        byJourney.set(h.journey, [...(byJourney.get(h.journey) ?? []), h.atCall === 0 ? "restart" : `${h.atCall}/${h.mode}`]);
      }
      console.log(`P2 known bug ${bug}: ${[...byJourney].map(([j, at]) => `${j} [${at.join(", ")}]`).join("; ")}`);
    }
  });

  for (const journey of JOURNEYS) {
    it(`${journey.name}: a worker killed at any adapter call resumes to the same outcome, or to a known bug`, async () => {
      const { adapterCalls, expected, findings } = await crashResume(journey);
      expect(adapterCalls).toBeGreaterThan(0);
      const unexplained: string[] = [];
      for (const f of findings) {
        const bug = explain(f, expected);
        if (bug === null) unexplained.push(summarize(f));
        else known.set(bug, [...(known.get(bug) ?? []), { journey: journey.name, atCall: f.atCall, mode: f.mode }]);
      }
      expect(unexplained).toEqual([]);
    });
  }

  for (const journey of JOURNEYS) {
    it(`${journey.name}: a worker replaced before every pass reaches the same outcome, or a known bug`, async () => {
      const { expected, finding } = await restartEveryPass(journey);
      if (finding === null) return;
      const bug = explain(finding, expected);
      if (bug !== null) {
        known.set(bug, [...(known.get(bug) ?? []), { journey: journey.name, atCall: 0, mode: "restart" }]);
      }
      expect(bug === null ? [summarize(finding)] : []).toEqual([]);
    });
  }

  for (const bug of Object.keys(P2_KNOWN_BUGS)) {
    it.fails(`KNOWN BUG ${bug}: no longer reproduces under any crash`, () => {
      expect(known.get(bug) ?? []).toEqual([]);
    });
  }
});
