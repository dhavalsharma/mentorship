import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SlackTransport } from "../slack/conversation.js";
import type { GoogleTransport } from "../google/calendar.js";
import type { GoogleDocsTransport } from "../google/document.js";
import type { GoogleSheetsTransport } from "../google/sheet.js";
import {
  classifyGoogle,
  classifySlack,
  fixtureFileName,
  fixtureStaleness,
  VENDORS,
  VendorFixtureSchema,
  type Classification,
  type ClassifiedRequest,
  type Staleness,
  type VendorFixture,
} from "./fixture.js";

/**
 * The other half of fixture capture: a transport that answers from
 * `tests/fixtures/vendor/**` instead of the network.
 *
 * Two checks run on every call, and they are what make this more than a
 * stub with the responses moved into JSON:
 *
 *   1. **No unobserved parameters.** Every query key and top-level body key
 *      the adapter sends must appear in the fixture's recorded request. An
 *      adapter that starts sending a parameter no capture has ever seen the
 *      vendor accept fails here, loudly, with "re-capture" in the message —
 *      rather than passing against a stub that accepts anything.
 *   2. **No invented response fields.** A test that needs state (a document
 *      whose text changes between calls) registers a handler, and the handler
 *      is handed the fixture's response to build from. Anything it returns at
 *      the top level must be a field the fixture actually has, so a stateful
 *      test cannot quietly drift into describing an API that does not exist.
 *
 * A call with no fixture at all throws `MissingFixtureError`, which is how the
 * fixture directory stays a complete list of the vendor surface the adapters
 * depend on.
 */

export class MissingFixtureError extends Error {
  constructor(classification: Classification | null, request: { method: string; path: string }) {
    super(
      classification
        ? `no vendor fixture for ${classification.vendor}/${fixtureFileName(classification.call, classification.variant)} — capture one (pnpm test:contracts:live) or hand-write it, marked source: "hand-written"`
        : `no route knows ${request.method} ${request.path} — add it to the route table in contracts/fixture.ts`,
    );
    this.name = "MissingFixtureError";
  }
}

export class ContractDriftError extends Error {
  constructor(message: string) {
    super(`${message} — the fixture no longer describes what the adapter does; re-capture it`);
    this.name = "ContractDriftError";
  }
}

export interface ReplayContext {
  request: ClassifiedRequest;
  fixture: VendorFixture;
  /** A fresh deep copy of the fixture's response — safe to modify and return. */
  response: Record<string, unknown>;
}

export type ReplayHandler = (
  ctx: ReplayContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface ReplayedCall {
  vendor: string;
  call: string;
  api?: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  fixture: VendorFixture;
}

export interface ReplayOptions {
  /** On by default. Off only to diagnose which check a test trips. */
  strict?: boolean;
}

export class VendorReplay {
  readonly calls: ReplayedCall[] = [];
  private readonly byName = new Map<string, VendorFixture>();
  private readonly handlers = new Map<string, ReplayHandler>();
  private readonly forced = new Map<string, string>();
  private readonly strict: boolean;

  constructor(fixtures: VendorFixture[], options: ReplayOptions = {}) {
    this.strict = options.strict ?? true;
    for (const f of fixtures) this.byName.set(key(f.call, f.variant), f);
  }

  /** Answer `call` from a handler built on the fixture, for tests that need state. */
  on(call: string, handler: ReplayHandler): this {
    this.handlers.set(call, handler);
    return this;
  }

  /** Serve a specific variant of `call` from now on — e.g. a recorded error. */
  use(call: string, variant: string | null): this {
    if (variant === null) this.forced.delete(call);
    else this.forced.set(call, variant);
    return this;
  }

  fixture(call: string, variant?: string): VendorFixture {
    const found = this.byName.get(key(call, variant));
    if (!found) throw new Error(`no fixture loaded for ${fixtureFileName(call, variant)}`);
    return found;
  }

  /** Every fixture a call was actually answered from, once each. */
  served(): VendorFixture[] {
    return [...new Set(this.calls.map((c) => c.fixture))];
  }

  staleServed(options?: { now?: Date; maxAgeDays?: number }): { fixture: VendorFixture; staleness: Staleness }[] {
    return this.served()
      .map((fixture) => ({ fixture, staleness: fixtureStaleness(fixture, options) }))
      .filter((s) => s.staleness.stale);
  }

  slack(): SlackTransport {
    return async (method, body) => {
      const sentBody = wire(body);
      return this.answer(classifySlack(method, body), {
        vendor: "slack",
        method: "POST",
        path: method,
        body: sentBody,
      });
    };
  }

  googleCalendar(): GoogleTransport {
    return async (path, init) =>
      this.answer(classifyGoogle({ method: init.method, path, ...(init.query ? { query: init.query } : {}) }), {
        vendor: "google-calendar",
        method: init.method,
        path,
        ...(init.query ? { query: init.query } : {}),
        ...(init.body === undefined ? {} : { body: wire(init.body) }),
      });
  }

  googleDocs(): GoogleDocsTransport {
    return (api, path, init) => this.twoApi(api, path, init, "google-docs");
  }

  googleSheets(): GoogleSheetsTransport {
    return (api, path, init) => this.twoApi(api, path, init, "google-sheets");
  }

  private twoApi(
    api: string,
    path: string,
    init: { method: string; body?: unknown; query?: Record<string, string> },
    fallbackVendor: ClassifiedRequest["vendor"],
  ): Promise<Record<string, unknown>> {
    const classification = classifyGoogle({
      api,
      method: init.method,
      path,
      ...(init.query ? { query: init.query } : {}),
    });
    return this.answer(classification, {
      vendor: classification?.vendor ?? fallbackVendor,
      api,
      method: init.method,
      path,
      ...(init.query ? { query: init.query } : {}),
      ...(init.body === undefined ? {} : { body: wire(init.body) }),
    });
  }

  private async answer(
    classification: Classification | null,
    request: ClassifiedRequest,
  ): Promise<Record<string, unknown>> {
    if (classification === null) throw new MissingFixtureError(null, request);

    const forced = this.forced.get(classification.call);
    const fixture =
      (forced !== undefined ? this.byName.get(key(classification.call, forced)) : undefined) ??
      (forced === undefined && classification.variant
        ? this.byName.get(key(classification.call, classification.variant))
        : undefined) ??
      (forced === undefined ? this.byName.get(key(classification.call)) : undefined);
    if (!fixture) {
      throw new MissingFixtureError(
        { ...classification, ...(forced ? { variant: forced } : {}) },
        request,
      );
    }

    this.calls.push({
      vendor: classification.vendor,
      call: classification.call,
      ...(request.api ? { api: request.api } : {}),
      method: request.method,
      path: request.path,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
      fixture,
    });

    if (this.strict) checkRequest(fixture, request);

    if (fixture.error) {
      // Same shape the http transports produce on a non-2xx: they throw.
      throw new Error(fixture.error.message);
    }

    const base = structuredClone(fixture.response!);
    const handler = this.handlers.get(classification.call);
    if (!handler) return base;

    const produced = await handler({ request, fixture, response: base });
    if (this.strict) {
      const known = new Set(Object.keys(fixture.response!));
      const invented = Object.keys(produced).filter((k) => !known.has(k));
      if (invented.length > 0) {
        throw new ContractDriftError(
          `handler for ${classification.call} returned ${invented.join(", ")}, which the ${fixture.source} fixture's response does not have`,
        );
      }
    }
    return produced;
  }
}

function key(call: string, variant?: string): string {
  return variant ? `${call}--${variant}` : call;
}

function wire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function checkRequest(fixture: VendorFixture, request: ClassifiedRequest): void {
  const label = `${fixture.vendor}/${fixtureFileName(fixture.call, fixture.variant)}`;
  if (fixture.request.method.toUpperCase() !== request.method.toUpperCase()) {
    throw new ContractDriftError(
      `${label} was recorded as ${fixture.request.method}, adapter sent ${request.method}`,
    );
  }
  const seenQuery = new Set(Object.keys(fixture.request.query ?? {}));
  const unseenQuery = Object.keys(request.query ?? {}).filter((k) => !seenQuery.has(k));
  if (unseenQuery.length > 0) {
    throw new ContractDriftError(
      `adapter sent query ${unseenQuery.join(", ")} to ${fixture.call}, which ${label} never recorded`,
    );
  }
  const seenBody = new Set(keysOf(fixture.request.body));
  const unseenBody = keysOf(request.body).filter((k) => !seenBody.has(k));
  if (unseenBody.length > 0) {
    throw new ContractDriftError(
      `adapter sent body field ${unseenBody.join(", ")} to ${fixture.call}, which ${label} never recorded`,
    );
  }
}

/**
 * Reads every `<dir>/<vendor>/*.json`. A malformed fixture, or one whose file
 * name disagrees with its own `call`/`variant`, throws with the path — a
 * fixture that silently fails to load is a test that silently stops checking.
 */
export function loadVendorFixtures(dir: string): VendorFixture[] {
  const out: VendorFixture[] = [];
  for (const vendor of VENDORS) {
    const vendorDir = join(dir, vendor);
    let names: string[];
    try {
      if (!statSync(vendorDir).isDirectory()) continue;
      names = readdirSync(vendorDir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(vendorDir, name);
      const parsed = VendorFixtureSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        throw new Error(`invalid vendor fixture ${file}: ${parsed.error.message}`);
      }
      const fixture = parsed.data;
      if (fixture.vendor !== vendor || fixtureFileName(fixture.call, fixture.variant) !== name) {
        throw new Error(
          `vendor fixture ${file} declares ${fixture.vendor}/${fixtureFileName(fixture.call, fixture.variant)}`,
        );
      }
      out.push(fixture);
    }
  }
  return out;
}
