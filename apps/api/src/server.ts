import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  handleSlackInteraction,
  type AgreementResponder,
  type ChatIdentityResolver,
} from "@mentorship/integrations";

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

export interface ApiServerDeps {
  slackSigningSecret: string;
  identity: ChatIdentityResolver;
  responder: AgreementResponder;
  /** Observability seam — see `SlackInteractionDeps.onUnhandled`. */
  onUnhandled?: (reason: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
  /**
   * Read-only admin endpoints. Optional so existing callers/tests that only
   * exercise the Slack route need not supply it; omitting it 404s the routes
   * below rather than throwing.
   */
  admin?: AdminReadsDeps;
}

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
        onUnhandled: deps.onUnhandled,
        now: deps.now,
      },
    );
    res.writeHead(result.status, { "content-type": "text/plain" });
    res.end(result.body ?? "");
    return;
  }

  if (req.method === "GET" && req.url) {
    const match = matchAdminRoute(req.url);
    if (match) {
      await handleAdminList(res, deps, match.orgId, match.limit, match.kind);
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
