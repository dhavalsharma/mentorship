import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlackTransport } from "../slack/conversation.js";
import type { GoogleTransport } from "../google/calendar.js";
import type { GoogleDocsTransport } from "../google/document.js";
import type { GmailTransport } from "../google/gmail.js";
import type { GoogleSheetsTransport } from "../google/sheet.js";
import {
  classifyGoogle,
  classifySlack,
  fixtureFileName,
  VendorFixtureSchema,
  type Classification,
  type VendorFixture,
} from "./fixture.js";
import { redact } from "./redact.js";

/**
 * Fixture capture (docs/e2e-testing-strategy.md, tier 4, mechanism 1).
 *
 * Wraps a real transport and writes every request/response pair it carries to
 * `<dir>/<vendor>/<call>.json`, redacted, dated and marked `source: "live"`.
 * The replay transport then serves those files to the adapter tests, so a stub
 * stops being an assumption and becomes an observation with a date on it.
 *
 * Sits *under* `SandboxGuard`, never over it: the guard wraps the adapter and
 * this wraps the adapter's transport, so a refused recipient throws before a
 * request exists to record.
 *
 * Capture is best-effort by construction. A failure to write a fixture is
 * reported through `onWarn` and swallowed — the live call it describes has
 * already happened, and turning a full disk into a failed Slack post would
 * make capture change the behaviour it exists to observe.
 */

export interface FixtureSink {
  write(fixture: VendorFixture): void;
}

export interface RecordingOptions {
  sink: FixtureSink;
  /** Injected so a test can pin `capturedOn`. */
  now?: () => Date;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Writes to `<dir>/<vendor>/<call>[--variant].json`; the newest capture of a call wins. */
export function fileFixtureSink(dir: string): FixtureSink & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write(fixture) {
      const vendorDir = join(dir, fixture.vendor);
      mkdirSync(vendorDir, { recursive: true });
      const file = join(vendorDir, fixtureFileName(fixture.call, fixture.variant));
      writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
      written.push(file);
    },
  };
}

/** Collects in memory — for tests of the capture path itself. */
export function memoryFixtureSink(): FixtureSink & { fixtures: VendorFixture[] } {
  const fixtures: VendorFixture[] = [];
  return { fixtures, write: (f) => void fixtures.push(f) };
}

function capture(
  options: RecordingOptions,
  classification: Classification,
  request: VendorFixture["request"],
  outcome: { response: Record<string, unknown> } | { error: unknown },
): void {
  try {
    const now = (options.now ?? (() => new Date()))();
    const isError = "error" in outcome;
    const variant = isError
      ? // An error never overwrites the success fixture for the same call.
        `error${classification.variant ? `-${classification.variant}` : ""}`
      : classification.variant;
    const fixture = VendorFixtureSchema.parse({
      vendor: classification.vendor,
      call: classification.call,
      ...(variant ? { variant } : {}),
      capturedOn: now.toISOString().slice(0, 10),
      source: "live",
      request: redact({ ...request, path: classification.template }),
      ...(isError
        ? {
            error: {
              message: redact(
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
              ),
            },
          }
        : { response: redact(outcome.response) }),
    });
    options.sink.write(fixture);
  } catch (caught) {
    options.onWarn?.("vendor fixture capture failed", {
      call: classification.call,
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

/** JSON round trip, so the fixture holds exactly what went over the wire (no `undefined`s). */
function wire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

async function recorded<T extends Record<string, unknown>>(
  options: RecordingOptions,
  classification: Classification | null,
  request: VendorFixture["request"],
  send: () => Promise<T>,
): Promise<T> {
  if (classification === null) {
    options.onWarn?.("vendor fixture capture skipped: unrecognised route", {
      method: request.method,
      path: request.path,
    });
    return send();
  }
  try {
    const response = await send();
    capture(options, classification, request, { response });
    return response;
  } catch (error) {
    capture(options, classification, request, { error });
    throw error;
  }
}

export function recordingSlackTransport(
  inner: SlackTransport,
  options: RecordingOptions,
): SlackTransport {
  return (method, body) =>
    recorded(
      options,
      classifySlack(method, body),
      { method: "POST", path: method, body: wire(body) },
      () => inner(method, body),
    );
}

export function recordingGoogleTransport(
  inner: GoogleTransport,
  options: RecordingOptions,
): GoogleTransport {
  return (path, init) =>
    recorded(
      options,
      classifyGoogle({ method: init.method, path, ...(init.query ? { query: init.query } : {}) }),
      {
        method: init.method,
        path,
        ...(init.query ? { query: init.query } : {}),
        ...(init.body === undefined ? {} : { body: wire(init.body) }),
      },
      () => inner(path, init),
    );
}

/**
 * Gmail's request body is one field, `raw`: the whole message, base64url. It
 * carries the recipient, the subject and — for a sign-in mail — the link, in a
 * form `redact` cannot see into. So the field is replaced with a fixed
 * placeholder *before* redaction, and a captured fixture keeps the shape
 * ("one raw field") and nothing else. Never record it, however harmless a
 * test message looks.
 */
export const GMAIL_RAW_PLACEHOLDER = "BASE64URL_RFC5322_MESSAGE";

export function recordingGoogleGmailTransport(
  inner: GmailTransport,
  options: RecordingOptions,
): GmailTransport {
  return (path, init) => {
    const body =
      init.body !== null && typeof init.body === "object" && "raw" in init.body
        ? { ...(init.body as Record<string, unknown>), raw: GMAIL_RAW_PLACEHOLDER }
        : init.body;
    return recorded(
      options,
      classifyGoogle({ method: init.method, path }),
      {
        method: init.method,
        path,
        ...(body === undefined ? {} : { body: wire(body) }),
      },
      () => inner(path, init),
    );
  };
}

function recordingTwoApi<A extends string>(
  inner: (
    api: A,
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string> },
  ) => Promise<Record<string, unknown>>,
  options: RecordingOptions,
) {
  return (
    api: A,
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string> },
  ) =>
    recorded(
      options,
      classifyGoogle({ api, method: init.method, path, ...(init.query ? { query: init.query } : {}) }),
      {
        api,
        method: init.method,
        path,
        ...(init.query ? { query: init.query } : {}),
        ...(init.body === undefined ? {} : { body: wire(init.body) }),
      },
      () => inner(api, path, init),
    );
}

export function recordingGoogleDocsTransport(
  inner: GoogleDocsTransport,
  options: RecordingOptions,
): GoogleDocsTransport {
  return recordingTwoApi(inner, options);
}

export function recordingGoogleSheetsTransport(
  inner: GoogleSheetsTransport,
  options: RecordingOptions,
): GoogleSheetsTransport {
  return recordingTwoApi(inner, options);
}
