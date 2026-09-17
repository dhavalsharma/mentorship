import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  extractDriveFolderId,
  extractGoogleDocId,
  handleSlackEvent,
  handleSlackInteraction,
  type AgreementResponder,
  type ChatIdentityResolver,
  type ExtractionResponder,
  type NotesSink,
  type PairingLocator,
} from "@mentorship/integrations";
import { DocumentPolicySchema } from "@mentorship/core";
import {
  requestMagicLink,
  verifyMagicLink,
  verifySession,
  type MagicLinkStore,
} from "@mentorship/auth";

/**
 * Deliberately not a framework. The one thing that matters for this route is
 * reading the *exact* raw bytes Slack signed — a body-parsing framework that
 * normalises, re-encodes or peeks at the body before the handler sees it will
 * make signature verification fail intermittently in a way that is miserable
 * to trace back to "the framework touched the body." Node's raw `http`
 * module hands over the bytes untouched, and this route is the only one that
 * exists yet — there is nothing here that a router would actually simplify.
 */

const MAX_BODY_BYTES = 1_000_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A query function the server calls without caring which backend answers it.
 * Postgres wires in a real query against `risk_findings`/`nudges`; the
 * in-memory testkit world has no equivalent concept yet, so it wires in
 * `notImplementedReads` instead — see `main.ts`.
 */
export type AdminListQuery = (orgId: string, limit: number) => Promise<unknown[]>;

export interface AdminReadsDeps {
  riskFindings: AdminListQuery;
  nudges: AdminListQuery;
}

/**
 * Settings for the `document` slot, split across two homes on purpose:
 * `namingTemplate` is program policy (data, per ADR-0001) and lives in
 * `programs.policy`, while the folder and guideline ids are vendor config and
 * live on `integration_bindings.config`. The form is one screen, so the store
 * writes both — but neither value is duplicated into the other's table, which
 * is what would make one of them a stale copy.
 */
export interface DocumentSettings {
  folderId: string | null;
  guidelineDocId: string | null;
  namingTemplate: string;
}

export interface DocumentSettingsStore {
  read(orgId: string): Promise<DocumentSettings>;
  write(orgId: string, settings: DocumentSettings): Promise<void>;
}

/**
 * This server is single-tenant-per-process (see `main.ts`'s `ORG_ID`), so
 * `orgId` here is the one org this whole process is bound to — the same
 * pattern `postgres-ports.ts`'s `PostgresPortOptions` already uses for
 * `identity`/`responder`. `verifySession` is called with *this* `orgId`, not
 * whatever `:orgId` a request's URL names, so a session issued for a
 * different org simply cannot resolve here — see `authenticateAdmin` below
 * for how that becomes the 401-vs-403 split invariant 3 requires.
 */
export interface AuthDeps {
  store: MagicLinkStore;
  orgId: string;
  /**
   * Fires only when `requestMagicLink` actually minted a token (a known
   * email) — never for an unknown one, so this callback's own invocation is
   * as enumeration-sensitive as `rawToken` itself and must never be wired to
   * anything the requester can observe. There is no email-sending
   * infrastructure in this repo (out of scope to build here); this is the
   * same "print it for a human to use" seam `apps/worker/src/seed-live-pair.ts`
   * already uses for a different manual-handoff step.
   */
  onMagicLinkIssued?: (email: string, rawToken: string) => void;
}

export interface ApiServerDeps {
  slackSigningSecret: string;
  identity: ChatIdentityResolver;
  responder: AgreementResponder;
  /** Confirm/Edit clicks. Absent means those clicks ack and do nothing. */
  extractions?: ExtractionResponder;
  /**
   * The Events API side — free-text notes arriving from a pair's own channel.
   * Absent 404s `/slack/events` rather than accepting messages it has nowhere
   * to put; a caller that only exercises interactions need not supply it.
   */
  slackEvents?: { locator: PairingLocator; notes: NotesSink };
  /** Observability seam — see `SlackInteractionDeps.onUnhandled`. */
  onUnhandled?: (reason: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
  /**
   * Read-only admin endpoints. Optional so existing callers/tests that only
   * exercise the Slack route need not supply it; omitting it 404s the routes
   * below rather than throwing.
   */
  admin?: AdminReadsDeps;
  /**
   * Read/write settings for the `document` slot. Optional for the same reason
   * `admin` is; absent, the routes below 501 rather than throwing.
   */
  documentSettings?: DocumentSettingsStore;
  /**
   * Magic-link auth. Optional for the same reason `admin` is — a caller that
   * only exercises the Slack route need not supply it — but its *absence*
   * on the admin routes below is treated as "nobody can authenticate", i.e.
   * a 401, never as "auth is skipped."
   */
  auth?: AuthDeps;
}

const SESSION_COOKIE = "mentorship_session";

/** A backend that has nothing to say for one of these routes — see `main.ts`. */
export function notImplementedReads(): AdminListQuery {
  return async () => {
    throw new NotImplementedError();
  };
}

export class NotImplementedError extends Error {}

export function createServer(deps: ApiServerDeps): Server {
  return createHttpServer((req, res) => {
    route(req, res, deps).catch((error) => {
      deps.onUnhandled?.("route_threw", {
        url: req.url,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/slack/interactions") {
    let rawBody: string;
    try {
      rawBody = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("payload too large");
      return;
    }

    const result = await handleSlackInteraction(
      { rawBody, headers: singleValueHeaders(req.headers) },
      {
        signingSecret: deps.slackSigningSecret,
        identity: deps.identity,
        responder: deps.responder,
        ...(deps.extractions ? { extractions: deps.extractions } : {}),
        onUnhandled: deps.onUnhandled,
        now: deps.now,
      },
    );
    writeWebhookResult(res, result);
    return;
  }

  if (req.method === "POST" && req.url === "/slack/events") {
    if (!deps.slackEvents) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    // Same discipline as the route above, and for the same reason: these are
    // the exact bytes Slack signed, read before anything looks at them.
    let rawBody: string;
    try {
      rawBody = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("payload too large");
      return;
    }

    const result = await handleSlackEvent(
      { rawBody, headers: singleValueHeaders(req.headers) },
      {
        signingSecret: deps.slackSigningSecret,
        identity: deps.identity,
        locator: deps.slackEvents.locator,
        notes: deps.slackEvents.notes,
        onUnhandled: deps.onUnhandled,
        now: deps.now,
      },
    );
    writeWebhookResult(res, result);
    return;
  }

  if (req.method === "POST" && req.url === "/auth/request-link") {
    await handleRequestLink(req, res, deps);
    return;
  }

  if (req.method === "POST" && req.url === "/auth/verify") {
    await handleVerify(req, res, deps);
    return;
  }

  if ((req.method === "GET" || req.method === "PUT") && req.url) {
    const orgId = matchDocumentSettingsRoute(req.url);
    if (orgId !== null) {
      await handleDocumentSettings(req, res, deps, orgId, req.method === "PUT");
      return;
    }
  }

  if (req.method === "GET" && req.url) {
    const match = matchAdminRoute(req.url);
    if (match) {
      await handleAdminList(req, res, deps, match.orgId, match.limit, match.kind);
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

/** `/orgs/:orgId/risk-findings` or `/orgs/:orgId/nudges`, with an optional `?limit=`. */
function matchAdminRoute(
  url: string,
): { orgId: string; limit: number; kind: "risk-findings" | "nudges" } | null {
  const parsed = new URL(url, "http://internal");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "orgs") return null;
  const [, orgId, resource] = segments as [string, string, string];
  if (resource !== "risk-findings" && resource !== "nudges") return null;

  const rawLimit = parsed.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
  const limit =
    parsedLimit === undefined || !Number.isFinite(parsedLimit) || parsedLimit <= 0
      ? DEFAULT_LIMIT
      : Math.min(Math.floor(parsedLimit), MAX_LIMIT);

  return { orgId: orgId!, limit, kind: resource };
}

async function handleAdminList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  orgId: string,
  limit: number,
  kind: "risk-findings" | "nudges",
): Promise<void> {
  if (!UUID_RE.test(orgId)) {
    writeJson(res, 400, { error: "orgId must be a UUID" });
    return;
  }

  // Authenticate first, then authorize the specific :orgId — see
  // `authenticateAdmin` for why a session's own org (not the URL) is the
  // source of truth, and CLAUDE.md invariant 3 for why that boundary is
  // non-negotiable even when the orgId in the URL is a real, guessable UUID.
  const authed = await authenticateAdmin(req, res, deps, orgId);
  if (!authed) return; // response already written (401 or 403)

  if (!deps.admin) {
    writeJson(res, 501, {
      error: "admin reads are not configured on this server",
    });
    return;
  }

  const query = kind === "risk-findings" ? deps.admin.riskFindings : deps.admin.nudges;
  try {
    const rows = await query(orgId, limit);
    writeJson(res, 200, rows);
  } catch (error) {
    if (error instanceof NotImplementedError) {
      writeJson(res, 501, {
        error: `the in-memory backend does not track ${kind}`,
      });
      return;
    }
    throw error;
  }
}

/** `/orgs/:orgId/settings/document`. */
function matchDocumentSettingsRoute(url: string): string | null {
  const parsed = new URL(url, "http://internal");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return null;
  const [orgs, orgId, settings, resource] = segments as [
    string,
    string,
    string,
    string,
  ];
  if (orgs !== "orgs" || settings !== "settings" || resource !== "document") {
    return null;
  }
  return orgId;
}

async function handleDocumentSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  orgId: string,
  isWrite: boolean,
): Promise<void> {
  if (!UUID_RE.test(orgId)) {
    writeJson(res, 400, { error: "orgId must be a UUID" });
    return;
  }

  const authed = await authenticateAdmin(req, res, deps, orgId);
  if (!authed) return; // response already written (401 or 403)

  const store = deps.documentSettings;
  if (!store) {
    writeJson(res, 501, {
      error: "document settings are not configured on this server",
    });
    return;
  }

  if (!isWrite) {
    writeJson(res, 200, await store.read(orgId));
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req, MAX_BODY_BYTES);
  } catch {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("payload too large");
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const parsed = parseDocumentSettings(body);
  if ("error" in parsed) {
    writeJson(res, 400, { error: parsed.error });
    return;
  }

  await store.write(orgId, parsed.settings);
  writeJson(res, 200, parsed.settings);
}

/**
 * `folder` and `guideline` accept either a pasted browser URL or a bare id —
 * an admin copying out of the address bar should not have to know which part
 * of it matters, and a hand-extracted id is a truncation waiting to happen.
 */
function parseDocumentSettings(
  body: Record<string, unknown>,
): { settings: DocumentSettings } | { error: string } {
  const folderRaw = typeof body["folder"] === "string" ? body["folder"] : "";
  const folderId = extractDriveFolderId(folderRaw);
  if (folderId === null) {
    return { error: "folder must be a Drive folder URL or id" };
  }

  const guidelineRaw =
    typeof body["guideline"] === "string" ? body["guideline"].trim() : "";
  let guidelineDocId: string | null = null;
  if (guidelineRaw.length > 0) {
    guidelineDocId = extractGoogleDocId(guidelineRaw);
    if (guidelineDocId === null) {
      return { error: "guideline must be a Google Doc URL or id" };
    }
  }

  const templateInput =
    typeof body["namingTemplate"] === "string" && body["namingTemplate"].trim()
      ? body["namingTemplate"].trim()
      : undefined;
  const template = DocumentPolicySchema.safeParse(
    templateInput === undefined ? {} : { namingTemplate: templateInput },
  );
  if (!template.success) {
    return { error: "namingTemplate must be 1–200 characters" };
  }

  return {
    settings: {
      folderId,
      guidelineDocId,
      namingTemplate: template.data.namingTemplate,
    },
  };
}

/**
 * No valid session -> 401. A valid session whose own org does not match the
 * `:orgId` in the URL -> 403 rather than proceeding — a session issued for
 * org A must never read org B's data, even when the URL is guessed
 * correctly (invariant 3). Because this server is single-tenant-per-process,
 * `deps.auth.orgId` already *is* the session's org: `verifySession` is
 * called scoped to it, never to the URL's `orgId`, so the org comparison
 * below is a plain equality check rather than a second trip to the store.
 */
async function authenticateAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  urlOrgId: string,
): Promise<{ userId: string } | null> {
  if (!deps.auth) {
    writeJson(res, 401, { error: "unauthorized" });
    return null;
  }

  const sessionId = readSessionCookie(req);
  if (!sessionId) {
    writeJson(res, 401, { error: "unauthorized" });
    return null;
  }

  const result = await verifySession({
    store: deps.auth.store,
    orgId: deps.auth.orgId,
    sessionId,
    now: deps.now ?? (() => new Date()),
  });
  if (!result.ok) {
    writeJson(res, 401, { error: "unauthorized" });
    return null;
  }

  if (deps.auth.orgId !== urlOrgId) {
    writeJson(res, 403, { error: "forbidden" });
    return null;
  }

  return { userId: result.userId };
}

async function handleRequestLink(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<void> {
  if (!deps.auth) {
    writeJson(res, 501, { error: "auth is not configured on this server" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req, MAX_BODY_BYTES);
  } catch {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("payload too large");
    return;
  }

  let email: unknown;
  try {
    email = (JSON.parse(rawBody) as { email?: unknown }).email;
  } catch {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof email !== "string" || email.length === 0) {
    writeJson(res, 400, { error: "email is required" });
    return;
  }

  // `result.rawToken` is enumeration-sensitive — present only for a known
  // email. It is used here (to fire the observability seam) and then
  // discarded; it must never influence the response written below, which is
  // the same shape and status regardless of `result`.
  const result = await requestMagicLink({
    store: deps.auth.store,
    orgId: deps.auth.orgId,
    email,
    now: deps.now ?? (() => new Date()),
  });
  if (result.rawToken !== null) {
    deps.auth.onMagicLinkIssued?.(email, result.rawToken);
  }

  writeJson(res, 200, { requested: true });
}

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
): Promise<void> {
  if (!deps.auth) {
    writeJson(res, 501, { error: "auth is not configured on this server" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req, MAX_BODY_BYTES);
  } catch {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("payload too large");
    return;
  }

  let token: unknown;
  try {
    token = (JSON.parse(rawBody) as { token?: unknown }).token;
  } catch {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof token !== "string" || token.length === 0) {
    writeJson(res, 400, { error: "token is required" });
    return;
  }

  const result = await verifyMagicLink({
    store: deps.auth.store,
    orgId: deps.auth.orgId,
    rawToken: token,
    now: deps.now ?? (() => new Date()),
  });
  if (!result.ok) {
    // Unlike the request-link step, a specific reason is safe here: holding
    // *a* token already proves the caller received the email, so telling
    // them it expired versus was already used leaks nothing new.
    writeJson(res, 401, { ok: false, reason: result.reason });
    return;
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": buildSessionCookie(result.sessionId, req),
  });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * `Secure` is skipped only for a request that arrived over plain
 * `http://localhost` (or `127.0.0.1`) — a real deployment always gets it.
 * This is a deliberate local-testing workaround, not a general rule: `curl`
 * and a browser talking to `pnpm serve:api` on localhost use plain HTTP, and
 * a `Secure` cookie is silently dropped by the client over plain HTTP, which
 * would make local testing of `/auth/verify` look broken. Anything that
 * reaches this server through a real hostname (or a TLS-terminating proxy in
 * front of it) gets `Secure` unconditionally.
 */
function buildSessionCookie(sessionId: string, req: IncomingMessage): string {
  const host = req.headers.host ?? "";
  const isLocalhost = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const attrs = [`${SESSION_COOKIE}=${sessionId}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (!isLocalhost) attrs.push("Secure");
  return attrs.join("; ");
}

function readSessionCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function writeWebhookResult(
  res: ServerResponse,
  result: { status: number; body?: string; contentType?: string },
): void {
  res.writeHead(result.status, {
    "content-type": result.contentType ?? "text/plain",
  });
  res.end(result.body ?? "");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Node folds repeated headers into arrays; Slack never sends this route's
 * headers more than once, so the first value is always the right one.
 */
function singleValueHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}
