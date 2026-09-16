import "server-only";
import { cookies } from "next/headers";

/**
 * Server components can't rely on `next.config.ts`'s `rewrites()` — that
 * proxy only intercepts requests that arrive at Next's own HTTP listener
 * (i.e. requests a browser sends). A server component's `fetch` happens
 * in-process and never goes through that listener, so it has to call
 * `apps/api` directly and forward the session cookie itself. Client
 * components (the login/verify pages) go through `/api/...` instead — see
 * `next.config.ts`.
 */
const API_ORIGIN = process.env["API_ORIGIN"] ?? "http://localhost:8787";

export type ServerApiResult<T> =
  | { status: "ok"; data: T }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "not_implemented" }
  | { status: "unreachable" }
  | { status: "error"; statusCode: number };

/**
 * Fetches an admin route (`/orgs/:orgId/...`) from `apps/api`, forwarding
 * the incoming request's session cookie. Never throws — a 401/403/501 are
 * expected outcomes callers branch on (redirect to /login, show a "not
 * tracked here" message, etc.), and even apps/api being unreachable
 * (connection refused, DNS failure) resolves to a status a page can render
 * a clear message for, rather than crashing the whole layout.
 */
export async function fetchAdminRoute<T>(path: string): Promise<ServerApiResult<T>> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
    });
  } catch {
    return { status: "unreachable" };
  }

  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 403) return { status: "forbidden" };
  if (response.status === 501) return { status: "not_implemented" };
  if (!response.ok) return { status: "error", statusCode: response.status };

  const data = (await response.json()) as T;
  return { status: "ok", data };
}
