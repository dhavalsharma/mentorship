import { z } from "zod";

/**
 * A vendor fixture: one request/response pair a Slack or Google API gave back,
 * written down with the date it was observed and *how* it was observed.
 *
 * The adapter tests used to run against hand-written stubs, which prove the
 * adapter calls the API the way its author believed the API worked — on the
 * day they wrote the stub. A fixture makes that belief a dated, checked-in
 * observation instead (docs/e2e-testing-strategy.md, tier 4), and `source`
 * keeps the difference honest: `"hand-written"` means a person typed it from
 * the vendor docs or an existing stub, `"live"` means `recordingTransport`
 * captured it from the real API. A hand-written fixture is an assumption with
 * a date on it, and the replay tests warn about every one they serve.
 */

export const VENDORS = [
  "slack",
  "google-calendar",
  "google-drive",
  "google-docs",
  "google-sheets",
  "google-gmail",
] as const;
export type Vendor = (typeof VENDORS)[number];

export const FixtureRequestSchema = z.object({
  /** Which Google API a two-API transport addressed (`drive`/`docs`/`sheets`). */
  api: z.string().optional(),
  /** HTTP verb. Slack's Web API is always POST. */
  method: z.string(),
  /**
   * The route *template* (`/files/{fileId}/revisions`), never the concrete
   * path — ids are tenant data and the replay matches on the route anyway.
   * For Slack it is the Web API method name (`chat.postMessage`).
   */
  path: z.string(),
  query: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});
export type FixtureRequest = z.infer<typeof FixtureRequestSchema>;

export const VendorFixtureSchema = z
  .object({
    vendor: z.enum(VENDORS),
    /** The vendor's own name for the call (`revisions.list`, `chat.postMessage`). */
    call: z.string().min(1),
    /** Distinguishes two materially different responses to one call. */
    variant: z.string().min(1).optional(),
    /** `YYYY-MM-DD`. For `hand-written`, the day it was written, not verified. */
    capturedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.enum(["live", "hand-written"]),
    /** Why this fixture looks the way it does, and what nobody has checked yet. */
    notes: z.string().optional(),
    request: FixtureRequestSchema,
    /** What the transport resolved with. Exactly one of `response`/`error`. */
    response: z.record(z.unknown()).optional(),
    /** What the transport threw — the http transports throw on a non-2xx. */
    error: z.object({ message: z.string() }).optional(),
  })
  .refine((f) => (f.response === undefined) !== (f.error === undefined), {
    message: "a fixture carries exactly one of `response` or `error`",
  });
export type VendorFixture = z.infer<typeof VendorFixtureSchema>;

/** `<call>.json`, or `<call>--<variant>.json`. The one naming rule both halves share. */
export function fixtureFileName(call: string, variant?: string): string {
  return `${call}${variant ? `--${variant}` : ""}.json`;
}

// ---------------------------------------------------------------------------
// Routes: which concrete request is which vendor call.
// ---------------------------------------------------------------------------

export interface ClassifiedRequest {
  vendor: Vendor;
  api?: string;
  method: string;
  /** Concrete, as the adapter sent it. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

interface Route {
  vendor: Vendor;
  api?: string;
  method: string;
  template: string;
  call: string;
  /**
   * When one call has materially different response shapes depending on
   * what was asked for (`files.get?fields=parents` vs the folder probe), the
   * variant keeps them in separate files, so a capture of one never
   * overwrites the other.
   */
  variant?: (request: ClassifiedRequest) => string | undefined;
}

function compile(template: string): RegExp {
  // `{name}` is one path segment. It stops at `:` too, because Google's
  // custom-method suffix (`:batchUpdate`, `:clear`) is part of the route, not
  // part of the id.
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) =>
      part.startsWith("{") ? "([^/:]+|'[^/]*')" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`);
}

const GOOGLE_ROUTES: Route[] = [
  // Calendar
  { vendor: "google-calendar", method: "GET", template: "/users/me/calendarList", call: "calendarList.list" },
  { vendor: "google-calendar", method: "POST", template: "/freeBusy", call: "freebusy.query" },
  { vendor: "google-calendar", method: "POST", template: "/calendars/{calendarId}/events", call: "events.insert" },
  { vendor: "google-calendar", method: "GET", template: "/calendars/{calendarId}/events/{eventId}", call: "events.get" },
  // Gmail — send only (`gmail.send` scope); no api key, like the Calendar transport.
  { vendor: "google-gmail", method: "POST", template: "/users/me/messages/send", call: "messages.send" },
  // Drive — shared by the document and sheet adapters.
  {
    vendor: "google-drive",
    api: "drive",
    method: "GET",
    template: "/files",
    call: "files.list",
    // The document adapter's create-once lookup (by the render's idempotency
    // key) and the sheet adapter's find-by-name are one call with different
    // questions; one capture must not clobber the other.
    variant: (r) => (r.query?.["q"]?.includes("appProperties has") ? "app-properties" : undefined),
  },
  { vendor: "google-drive", api: "drive", method: "POST", template: "/files", call: "files.create" },
  {
    vendor: "google-drive",
    api: "drive",
    method: "GET",
    template: "/files/{fileId}",
    call: "files.get",
    variant: (r) => (r.query?.["fields"] === "parents" ? "parents" : undefined),
  },
  { vendor: "google-drive", api: "drive", method: "PATCH", template: "/files/{fileId}", call: "files.update" },
  { vendor: "google-drive", api: "drive", method: "POST", template: "/files/{fileId}/copy", call: "files.copy" },
  { vendor: "google-drive", api: "drive", method: "GET", template: "/files/{fileId}/permissions", call: "permissions.list" },
  { vendor: "google-drive", api: "drive", method: "POST", template: "/files/{fileId}/permissions", call: "permissions.create" },
  { vendor: "google-drive", api: "drive", method: "GET", template: "/files/{fileId}/revisions", call: "revisions.list" },
  // Docs
  { vendor: "google-docs", api: "docs", method: "GET", template: "/documents/{documentId}", call: "documents.get" },
  { vendor: "google-docs", api: "docs", method: "POST", template: "/documents/{documentId}:batchUpdate", call: "documents.batchUpdate" },
  // Sheets. `values.clear` before `values.update`: the update template would
  // otherwise swallow the `:clear` suffix as part of the range.
  { vendor: "google-sheets", api: "sheets", method: "POST", template: "/spreadsheets", call: "spreadsheets.create" },
  { vendor: "google-sheets", api: "sheets", method: "GET", template: "/spreadsheets/{spreadsheetId}", call: "spreadsheets.get" },
  { vendor: "google-sheets", api: "sheets", method: "POST", template: "/spreadsheets/{spreadsheetId}:batchUpdate", call: "spreadsheets.batchUpdate" },
  { vendor: "google-sheets", api: "sheets", method: "POST", template: "/spreadsheets/{spreadsheetId}/values/{range}:clear", call: "spreadsheets.values.clear" },
  { vendor: "google-sheets", api: "sheets", method: "PUT", template: "/spreadsheets/{spreadsheetId}/values/{range}", call: "spreadsheets.values.update" },
];

const COMPILED = GOOGLE_ROUTES.map((route) => ({ route, regex: compile(route.template) }));

export interface Classification {
  vendor: Vendor;
  call: string;
  variant?: string;
  template: string;
}

/**
 * Slack's routes are its method names. The one variant worth keeping apart
 * is `chat.postMessage`: a proposal, a confirmation and a plain message have
 * different request shapes, and one capture must not clobber the others.
 */
export function classifySlack(method: string, body: Record<string, unknown>): Classification {
  let variant: string | undefined;
  if (method === "chat.postMessage") {
    const metadata = body["metadata"] as { event_type?: unknown } | undefined;
    if (typeof metadata?.event_type === "string") variant = metadata.event_type;
  }
  return { vendor: "slack", call: method, template: method, ...(variant ? { variant } : {}) };
}

/** Null for a route nobody has named yet — the caller decides what that means. */
export function classifyGoogle(request: Omit<ClassifiedRequest, "vendor">): Classification | null {
  const path = decodeURIComponentSafe(request.path);
  for (const { route, regex } of COMPILED) {
    if (route.method !== request.method.toUpperCase()) continue;
    if (route.api !== undefined && request.api !== undefined && route.api !== request.api) continue;
    if (route.api === undefined && request.api !== undefined) continue;
    if (!regex.test(path)) continue;
    const variant = route.variant?.({ ...request, vendor: route.vendor });
    return {
      vendor: route.vendor,
      call: route.call,
      template: route.template,
      ...(variant ? { variant } : {}),
    };
  }
  return null;
}

/** Every Google call this repo knows how to name — the replay test's coverage list. */
export function knownGoogleCalls(): { vendor: Vendor; call: string; template: string }[] {
  return GOOGLE_ROUTES.map((r) => ({ vendor: r.vendor, call: r.call, template: r.template }));
}

function decodeURIComponentSafe(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export interface Staleness {
  stale: boolean;
  reasons: string[];
}

/**
 * Warn-worthy, never fail-worthy: a fixture going stale is a prompt to re-run
 * the live contract suite, not a reason the PR in front of you is wrong.
 */
export function fixtureStaleness(
  fixture: Pick<VendorFixture, "source" | "capturedOn">,
  options: { now?: Date; maxAgeDays?: number } = {},
): Staleness {
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? 90;
  const reasons: string[] = [];
  if (fixture.source === "hand-written") {
    reasons.push("hand-written — never captured from the live API");
  }
  const captured = Date.parse(`${fixture.capturedOn}T00:00:00Z`);
  const ageDays = Math.floor((now.getTime() - captured) / 86_400_000);
  if (Number.isFinite(ageDays) && ageDays > maxAgeDays) {
    reasons.push(`${ageDays} days old (limit ${maxAgeDays})`);
  }
  return { stale: reasons.length > 0, reasons };
}
