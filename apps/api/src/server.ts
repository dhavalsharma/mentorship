import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  extractDriveFolderId,
  extractGoogleDocId,
  extractSpreadsheetId,
  handleSlackEvent,
  handleSlackInteraction,
  type AgreementResponder,
  type ChatIdentityResolver,
  type CounterContextResolver,
  type ExtractionResponder,
  type NotesSink,
  type PairingLocator,
  type PairPreferencesStore,
  type SlackModalOpener,
  type SlackPreferencesModalOpener,
} from "@mentorship/integrations";
import {
  asOrgId,
  authorize,
  DocumentPolicySchema,
  type Actor,
  type Resource,
  type ResourceType,
  type StaffRole,
} from "@mentorship/core";
import {
  requestMagicLink,
  verifyMagicLink,
  verifySession,
  type MagicLinkStore,
  type StaffDirectory,
} from "@mentorship/auth";
import { planInvite, type InvitePlan } from "@mentorship/enrollment";
import { InviteRequestSchema, defaultDisplayName } from "./invites.js";

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

const DEFAULT_STUCK_DAYS = 3;
const MAX_STUCK_DAYS = 90;

/**
 * A query function the server calls without caring which backend answers it.
 * Postgres wires in a real query against `risk_findings`/`nudges`; the
 * in-memory testkit world has no equivalent concept yet, so it wires in
 * `notImplementedReads` instead — see `main.ts`.
 */
export type AdminListQuery = (orgId: string, limit: number) => Promise<unknown[]>;

/**
 * Same idea as `AdminListQuery`, with the one extra dimension "stuck" needs:
 * how many days without progress counts as stuck. Kept as a distinct type
 * rather than overloading `AdminListQuery` so a backend that wires the wrong
 * query in for the wrong route is a type error, not a runtime surprise.
 */
export type StuckSagaQuery = (
  orgId: string,
  limit: number,
  olderThanDays: number,
) => Promise<unknown[]>;

/**
 * `runId` is an `ai_runs.id` — a matching round's `PostgresAiRunSink.record`
 * call is what created it (see `packages/primitives/matching/src/round.ts`),
 * so there is no separate "round id" concept to resolve, only the id of the
 * run that produced it. `null` means the id does not resolve to a matching
 * run for this org — not found, or not a matching primitive's run — which
 * the route turns into a 404 rather than an empty list.
 */
export type MatchingRoundCandidatesQuery = (
  orgId: string,
  runId: string,
) => Promise<unknown | null>;

export interface AdminReadsDeps {
  riskFindings: AdminListQuery;
  nudges: AdminListQuery;
  /** ROADMAP phase 1's monitoring gap — see `packages/workflows/src/postgres-reads.ts`. */
  stuckSagas: StuckSagaQuery;
  deadLetters: AdminListQuery;
  matchingRoundCandidates: MatchingRoundCandidatesQuery;
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
 * Settings for the `sheet` slot — the report-sync spreadsheet destination.
 * `folderId` is where a new spreadsheet is created when none is configured
 * yet; `spreadsheetId` is filled in either by an admin pasting an existing
 * spreadsheet, or by the sync job persisting the one it created (see
 * `apps/worker/src/reports.ts`). Both live on `integration_bindings.config`
 * — unlike `document`, there is no program-policy half (no per-report
 * naming template), so this is the simpler of the two settings shapes.
 */
export interface SheetSettings {
  folderId: string | null;
  spreadsheetId: string | null;
}

export interface SheetSettingsStore {
  read(orgId: string): Promise<SheetSettings>;
  write(orgId: string, settings: SheetSettings): Promise<void>;
}

/**
 * This server is single-tenant-per-process (see `main.ts`'s `ORG_ID`), so
 * `orgId` here is the one org this whole process is bound to — the same
 * pattern `postgres-ports.ts`'s `PostgresPortOptions` already uses for
 * `identity`/`responder`. `verifySession` is called with *this* `orgId`, not
 * whatever `:orgId` a request's URL names, so a session issued for a
 * different org simply cannot resolve here — see `authenticateStaff` below
 * for how that becomes the 401-vs-403 split invariant 3 requires.
 */
export interface AuthDeps {
  store: MagicLinkStore;
  /**
   * Who in this org is staff (ADR-0010). Required, not optional: a valid
   * session proves only that someone controls an email address — every
   * invited mentee has one — so a deployment that wired `store` without this
   * would hand the admin routes to anyone with a sign-in link. Making it a
   * compile error to omit is the point.
   */
  staff: StaffDirectory;
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

/**
 * What `POST /orgs/:orgId/invites` commits, and what `POST /auth/verify`
 * runs once someone has proven control of their email. Postgres implements
 * it as one `withTenant` transaction per call (`postgres-enrollment.ts`); the
 * route never sees a sink or a transaction.
 */
export type InviteOutcome =
  | { ok: true; participantId: string; alreadyInvited: boolean; state: string }
  /** No cohort with that id in *this* org — which, under RLS, includes another org's. */
  | { ok: false; reason: "unknown_cohort" }
  /** The cohort's program does not define that role (ADR-0001: roles are policy data). */
  | { ok: false; reason: "unknown_role"; roles: string[] };

export interface EnrollmentService {
  invite(orgId: string, plan: InvitePlan, actorUserId: string): Promise<InviteOutcome>;
  acceptPendingInvites(orgId: string, userId: string): Promise<{ accepted: string[] }>;
}

export interface ApiServerDeps {
  slackSigningSecret: string;
  identity: ChatIdentityResolver;
  responder: AgreementResponder;
  /** Confirm/Edit clicks. Absent means those clicks ack and do nothing. */
  extractions?: ExtractionResponder;
  /**
   * "Suggest another": the modal opener (called synchronously, inside the
   * click's own request, because a trigger_id lives about three seconds) and
   * the reads its submission needs. Absent, a counter click acks and is
   * recorded as unhandled — what this endpoint did before the modal existed.
   */
  counterModal?: { modals: SlackModalOpener; counters: CounterContextResolver };
  /**
   * "Session preferences": a pair choosing its own length and rhythm. Same
   * shape and same reason as `counterModal` — the opener runs inside the
   * click's request — plus the store its submission writes through. Absent,
   * the click acks and is recorded as unhandled.
   */
  preferences?: {
    modals: SlackPreferencesModalOpener;
    store: PairPreferencesStore;
  };
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
   * Read/write settings for the `sheet` slot. Optional for the same reason
   * `documentSettings` is; absent, the routes below 501 rather than
   * throwing.
   */
  sheetSettings?: SheetSettingsStore;
  /**
   * Magic-link auth. Optional for the same reason `admin` is — a caller that
   * only exercises the Slack route need not supply it — but its *absence*
   * on the admin routes below is treated as "nobody can authenticate", i.e.
   * a 401, never as "auth is skipped."
   */
  auth?: AuthDeps;
  /**
   * Cohort invites, and accepting them on sign-in. Absent, the invite route
   * 501s (after auth — an unauthenticated caller still gets a 401) and
   * `/auth/verify` signs people in without touching any invite.
   */
  enrollment?: EnrollmentService;
}

const SESSION_COOKIE = "mentorship_session";

/** A backend that has nothing to say for one of these routes — see `main.ts`. */
export function notImplementedReads(): AdminListQuery {
  return async () => {
    throw new NotImplementedError();
  };
}

/** Same idea as `notImplementedReads`, for the differently-shaped matching-rounds query. */
export function notImplementedMatchingReads(): MatchingRoundCandidatesQuery {
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
        ...(deps.counterModal
          ? {
              modals: deps.counterModal.modals,
              counters: deps.counterModal.counters,
            }
          : {}),
        ...(deps.preferences ? { preferences: deps.preferences } : {}),
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

  if (req.method === "POST" && req.url) {
    const orgId = matchInvitesRoute(req.url);
    if (orgId !== null) {
      await handleInvite(req, res, deps, orgId);
      return;
    }
  }

  if ((req.method === "GET" || req.method === "PUT") && req.url) {
    const orgId = matchDocumentSettingsRoute(req.url);
    if (orgId !== null) {
      await handleDocumentSettings(req, res, deps, orgId, req.method === "PUT");
      return;
    }
  }

  if ((req.method === "GET" || req.method === "PUT") && req.url) {
    const orgId = matchSheetSettingsRoute(req.url);
    if (orgId !== null) {
      await handleSheetSettings(req, res, deps, orgId, req.method === "PUT");
      return;
    }
  }

  if (req.method === "GET" && req.url) {
    const match = matchAdminRoute(req.url);
    if (match) {
      await handleAdminList(
        req,
        res,
        deps,
        match.orgId,
        match.limit,
        match.olderThanDays,
        match.kind,
      );
      return;
    }
  }

  if (req.method === "GET" && req.url) {
    const match = matchMatchingRoundCandidatesRoute(req.url);
    if (match) {
      await handleMatchingRoundCandidates(req, res, deps, match.orgId, match.runId);
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

type AdminListKind = "risk-findings" | "nudges" | "stuck-sagas" | "dead-letters";

const ADMIN_LIST_KINDS: readonly AdminListKind[] = [
  "risk-findings",
  "nudges",
  "stuck-sagas",
  "dead-letters",
];

/**
 * The visibility-matrix resource type each admin-list kind authorizes as.
 * A `Record` over the full `AdminListKind` union rather than a ternary — a
 * new kind added to the union without an entry here is a compile error
 * instead of silently falling through to the wrong resource type (the bug
 * this replaced: `stuck-sagas`/`dead-letters` were both being checked as
 * `"nudge"`).
 */
const ADMIN_LIST_RESOURCE_TYPE: Record<AdminListKind, ResourceType> = {
  "risk-findings": "risk-finding",
  nudges: "nudge",
  "stuck-sagas": "operational-monitoring",
  "dead-letters": "operational-monitoring",
};

/**
 * `/orgs/:orgId/{risk-findings,nudges,stuck-sagas,dead-letters}`, with an
 * optional `?limit=` (all four) and `?days=` (`stuck-sagas` only — how many
 * days without progress counts as stuck).
 */
function matchAdminRoute(
  url: string,
): { orgId: string; limit: number; olderThanDays: number; kind: AdminListKind } | null {
  const parsed = new URL(url, "http://internal");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "orgs") return null;
  const [, orgId, resource] = segments as [string, string, string];
  if (!ADMIN_LIST_KINDS.includes(resource as AdminListKind)) return null;

  const rawLimit = parsed.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
  const limit =
    parsedLimit === undefined || !Number.isFinite(parsedLimit) || parsedLimit <= 0
      ? DEFAULT_LIMIT
      : Math.min(Math.floor(parsedLimit), MAX_LIMIT);

  const rawDays = parsed.searchParams.get("days");
  const parsedDays = rawDays === null ? undefined : Number(rawDays);
  const olderThanDays =
    parsedDays === undefined || !Number.isFinite(parsedDays) || parsedDays <= 0
      ? DEFAULT_STUCK_DAYS
      : Math.min(Math.floor(parsedDays), MAX_STUCK_DAYS);

  return { orgId: orgId!, limit, olderThanDays, kind: resource as AdminListKind };
}

async function handleAdminList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  orgId: string,
  limit: number,
  olderThanDays: number,
  kind: AdminListKind,
): Promise<void> {
  if (!UUID_RE.test(orgId)) {
    writeJson(res, 400, { error: "orgId must be a UUID" });
    return;
  }

  // Authenticate, resolve the caller's staff role, then authorize the
  // specific resource — see `authenticateStaff` for why a session's own org
  // (not the URL) is the source of truth (invariant 3), and
  // `authorizeStaff` for why authorization runs even though every staff
  // role can read these lists today (invariant 14).
  const staff = await authenticateStaff(req, res, deps, orgId);
  if (!staff) return; // response already written (401 or 403)
  if (!authorizeStaff(res, staff, { type: ADMIN_LIST_RESOURCE_TYPE[kind], orgId: asOrgId(orgId) })) {
    return;
  }

  if (!deps.admin) {
    writeJson(res, 501, {
      error: "admin reads are not configured on this server",
    });
    return;
  }

  try {
    const rows =
      kind === "risk-findings"
        ? await deps.admin.riskFindings(orgId, limit)
        : kind === "nudges"
          ? await deps.admin.nudges(orgId, limit)
          : kind === "stuck-sagas"
            ? await deps.admin.stuckSagas(orgId, limit, olderThanDays)
            : await deps.admin.deadLetters(orgId, limit);
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

/** `/orgs/:orgId/matching-rounds/:runId/candidates` — the appeal-UI read model. */
function matchMatchingRoundCandidatesRoute(
  url: string,
): { orgId: string; runId: string } | null {
  const parsed = new URL(url, "http://internal");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return null;
  const [orgs, orgId, resource, runId, tail] = segments as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (orgs !== "orgs" || resource !== "matching-rounds" || tail !== "candidates") {
    return null;
  }
  return { orgId: orgId!, runId: runId! };
}

async function handleMatchingRoundCandidates(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  orgId: string,
  runId: string,
): Promise<void> {
  if (!UUID_RE.test(orgId) || !UUID_RE.test(runId)) {
    writeJson(res, 400, { error: "orgId and runId must both be UUIDs" });
    return;
  }

  // Same authenticate-then-authorize order as `handleAdminList`. A matching
  // round's candidates are org-wide appeal data (`matching-candidates`),
  // never a named person's sentiment — but no route skips `authorize` just
  // because it happens not to carry attributable feedback today.
  const staff = await authenticateStaff(req, res, deps, orgId);
  if (!staff) return; // response already written (401 or 403)
  if (!authorizeStaff(res, staff, { type: "matching-candidates", orgId: asOrgId(orgId) })) {
    return;
  }

  if (!deps.admin) {
    writeJson(res, 501, {
      error: "admin reads are not configured on this server",
    });
    return;
  }

  try {
    const result = await deps.admin.matchingRoundCandidates(orgId, runId);
    if (result === null) {
      writeJson(res, 404, { error: "no matching round found for that run id" });
      return;
    }
    writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof NotImplementedError) {
      writeJson(res, 501, {
        error: "the in-memory backend does not track matching rounds",
      });
      return;
    }
    throw error;
  }
}

/** `/orgs/:orgId/invites`. */
function matchInvitesRoute(url: string): string | null {
  const parsed = new URL(url, "http://internal");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 3) return null;
  const [orgs, orgId, resource] = segments as [string, string, string];
  if (orgs !== "orgs" || resource !== "invites") return null;
  return orgId;
}

/**
 * One admin, one email, one cohort, one role. 201 for a new invite, 200 for a
 * repeat (a dedupe, not an error — the same rule `commitInvite` applies), 400
 * with per-field issues for anything malformed or naming a cohort or role
 * this org does not have.
 *
 * While the participant is still `invited`, every call — first or repeat —
 * issues a fresh magic link through the same `onMagicLinkIssued` seam
 * `/auth/request-link` uses, so re-inviting doubles as "resend". The raw
 * token never reaches this response: the admin must not be able to sign in
 * as the person they invited. Following that link is what accepts the
 * invite — see `handleVerify`.
 */
async function handleInvite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  orgId: string,
): Promise<void> {
  if (!UUID_RE.test(orgId)) {
    writeJson(res, 400, { error: "orgId must be a UUID" });
    return;
  }

  // Inviting decides who is in the program, so it is the route an invited
  // participant must least be able to reach — `authenticateStaff` refuses
  // any session whose user has no staff role before this is ever asked.
  const staff = await authenticateStaff(req, res, deps, orgId);
  if (!staff) return; // response already written (401 or 403)
  if (!authorizeStaff(res, staff, { type: "enrolment.invite", orgId: asOrgId(orgId) })) {
    return;
  }

  if (!deps.enrollment) {
    writeJson(res, 501, { error: "enrolment is not configured on this server" });
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

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const body = InviteRequestSchema.safeParse(json);
  if (!body.success) {
    writeJson(res, 400, {
      error: "invalid invite",
      issues: body.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? ""),
        message: issue.message,
      })),
    });
    return;
  }

  const planned = planInvite({
    email: body.data.email,
    displayName: body.data.displayName ?? defaultDisplayName(body.data.email),
    // An invite rarely knows someone's zone. 0 only ever lands on a *new*
    // user row — the Postgres sink never overwrites an existing one — and is
    // the same default `users.tz_offset_minutes` already has.
    tzOffsetMinutes: body.data.tzOffsetMinutes ?? 0,
    cohortId: body.data.cohortId,
    role: body.data.role,
    ...(body.data.capacity !== undefined ? { capacity: body.data.capacity } : {}),
    orgId,
  });
  if (!planned.ok) {
    writeJson(res, 400, { error: "invalid invite", issues: planned.issues });
    return;
  }

  const outcome = await deps.enrollment.invite(orgId, planned.plan, staff.userId);
  if (!outcome.ok) {
    const issue =
      outcome.reason === "unknown_cohort"
        ? { field: "cohortId", message: "no such cohort in this organisation" }
        : {
            field: "role",
            message: `not a role in this cohort's program (expected one of: ${outcome.roles.join(", ")})`,
          };
    writeJson(res, 400, { error: "invalid invite", issues: [issue] });
    return;
  }

  let signInLinkIssued = false;
  if (outcome.state === "invited" && deps.auth) {
    const link = await requestMagicLink({
      store: deps.auth.store,
      orgId: deps.auth.orgId,
      email: planned.plan.email,
      now: deps.now ?? (() => new Date()),
    });
    if (link.rawToken !== null) {
      deps.auth.onMagicLinkIssued?.(planned.plan.email, link.rawToken);
      signInLinkIssued = true;
    }
  }

  writeJson(res, outcome.alreadyInvited ? 200 : 201, {
    participantId: outcome.participantId,
    alreadyInvited: outcome.alreadyInvited,
    state: outcome.state,
    signInLinkIssued,
  });
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

  // Reads as well as writes: the folder and guideline ids are the tenant's
  // wiring, and `integration.settings` is admin-only in the matrix.
  const staff = await authenticateStaff(req, res, deps, orgId);
  if (!staff) return; // response already written (401 or 403)
  if (!authorizeStaff(res, staff, { type: "integration.settings", orgId: asOrgId(orgId) })) {
    return;
  }

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

/** `/orgs/:orgId/settings/sheet`. */
function matchSheetSettingsRoute(url: string): string | null {
  const parsed = new URL(url, "http://internal");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4) return null;
  const [orgs, orgId, settings, resource] = segments as [
    string,
    string,
    string,
    string,
  ];
  if (orgs !== "orgs" || settings !== "settings" || resource !== "sheet") {
    return null;
  }
  return orgId;
}

async function handleSheetSettings(
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

  // Same gate as `handleDocumentSettings`, for the same reason.
  const staff = await authenticateStaff(req, res, deps, orgId);
  if (!staff) return; // response already written (401 or 403)
  if (!authorizeStaff(res, staff, { type: "integration.settings", orgId: asOrgId(orgId) })) {
    return;
  }

  const store = deps.sheetSettings;
  if (!store) {
    writeJson(res, 501, {
      error: "sheet settings are not configured on this server",
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

  const parsed = parseSheetSettings(body);
  if ("error" in parsed) {
    writeJson(res, 400, { error: parsed.error });
    return;
  }

  await store.write(orgId, parsed.settings);
  writeJson(res, 200, parsed.settings);
}

/**
 * `folder` accepts either a pasted Drive folder URL or a bare id, same
 * reasoning as `parseDocumentSettings`. `spreadsheet` is optional — an admin
 * who already has a spreadsheet may paste its URL or id to point sync at it
 * directly, rather than let the first sync create one.
 */
function parseSheetSettings(
  body: Record<string, unknown>,
): { settings: SheetSettings } | { error: string } {
  const folderRaw = typeof body["folder"] === "string" ? body["folder"] : "";
  const folderId = extractDriveFolderId(folderRaw);
  if (folderId === null) {
    return { error: "folder must be a Drive folder URL or id" };
  }

  const spreadsheetRaw =
    typeof body["spreadsheet"] === "string" ? body["spreadsheet"].trim() : "";
  let spreadsheetId: string | null = null;
  if (spreadsheetRaw.length > 0) {
    spreadsheetId = extractSpreadsheetId(spreadsheetRaw);
    if (spreadsheetId === null) {
      return { error: "spreadsheet must be a Google Sheets URL or id" };
    }
  }

  return { settings: { folderId, spreadsheetId } };
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

/** A signed-in, org-matched caller who is staff — see `authenticateStaff`. */
interface StaffCaller {
  userId: string;
  orgId: string;
  role: StaffRole;
}

/**
 * No valid session -> 401. A valid session whose own org does not match the
 * `:orgId` in the URL -> 403 rather than proceeding — a session issued for
 * org A must never read org B's data, even when the URL is guessed
 * correctly (invariant 3). Because this server is single-tenant-per-process,
 * `deps.auth.orgId` already *is* the session's org: `verifySession` is
 * called scoped to it, never to the URL's `orgId`, so the org comparison
 * below is a plain equality check rather than a second trip to the store.
 *
 * A valid, org-matched session whose user is not staff -> 403 as well, with
 * the identical body (ADR-0010). A magic link proves who someone is, and
 * every invited participant can get one; it never proves they run the
 * program. The body does not say *which* 403 this is: a participant probing
 * the API learns nothing about whether the org id was right.
 */
async function authenticateStaff(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  urlOrgId: string,
): Promise<StaffCaller | null> {
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

  const role = await deps.auth.staff.staffRoleOf(deps.auth.orgId, result.userId);
  if (role === null) {
    writeJson(res, 403, { error: "forbidden" });
    return null;
  }

  return { userId: result.userId, orgId: deps.auth.orgId, role };
}

/**
 * The visibility-matrix check every staff route runs after
 * `authenticateStaff`, with the caller's *resolved* role — never an assumed
 * one. Being staff gets a caller to the door; `authorize` decides which
 * doors (a program lead may list and invite, only an admin may touch
 * integration settings). Writes the 403 itself and returns false on deny.
 *
 * `pairingIds` is empty because a staff caller is authorized as org-chart
 * staff, not as a pair member. A future route that reads something
 * pair-scoped (feedback sentiment, a participant-attributed signal) must
 * resolve the caller's real pairing membership first — for staff that
 * membership grants nothing extra here, and for invariant 14 it must not.
 */
function authorizeStaff(
  res: ServerResponse,
  caller: StaffCaller,
  resource: Resource,
): boolean {
  const actor: Actor = { orgId: asOrgId(caller.orgId), role: caller.role, pairingIds: [] };
  const decision = authorize(actor, resource);
  if (!decision.allowed) {
    writeJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
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

  // Proving control of the email *is* the invite's verification step: the
  // link could only have reached someone who reads that inbox. Best-effort
  // and invisible in the response — a sign-in never fails because enrolment
  // did, the response is byte-identical whether or not anything was
  // accepted (so it says nothing about which emails were invited), and a
  // failed acceptance is simply retried by the next sign-in, since
  // `acceptPendingInvites` is idempotent.
  if (deps.enrollment) {
    try {
      await deps.enrollment.acceptPendingInvites(deps.auth.orgId, result.userId);
    } catch (error) {
      deps.onUnhandled?.("invite_accept_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
