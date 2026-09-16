import type { ServerApiResult } from "@/lib/server-api";

/**
 * Maps every non-"ok" `ServerApiResult` status to a human-readable message,
 * shared by the risk-findings and nudges pages so the two tables degrade
 * identically. Returns `null` for "ok", since that case is the caller's own
 * table/empty-list rendering, not a message.
 */
export function adminResultMessage(
  result: ServerApiResult<unknown>,
  resourceLabel: string,
): string | null {
  switch (result.status) {
    case "ok":
      return null;
    case "not_implemented":
      return `This backend doesn't track ${resourceLabel} yet — it's running the in-memory dev world, which predates this table. Point apps/api at Postgres (DATABASE_URL) to see real data here.`;
    case "unauthorized":
    case "forbidden":
      return "Your session can no longer read this org's data. Try signing in again.";
    case "unreachable":
      return "Couldn't reach the API server. Check that apps/api is running.";
    case "error":
      return `The server returned an unexpected error (status ${result.statusCode}).`;
  }
}
