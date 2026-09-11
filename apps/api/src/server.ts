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

export interface ApiServerDeps {
  slackSigningSecret: string;
  identity: ChatIdentityResolver;
  responder: AgreementResponder;
  /** Observability seam — see `SlackInteractionDeps.onUnhandled`. */
  onUnhandled?: (reason: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
}

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

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
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
