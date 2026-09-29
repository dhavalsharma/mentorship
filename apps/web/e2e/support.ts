import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import type { BrowserContext } from "@playwright/test";

/**
 * Shared by the global setup (main process) and every spec (worker process).
 *
 * The global setup seeds two fresh orgs and publishes what it seeded through
 * `process.env` — Playwright forks workers after global setup finishes, so
 * they inherit it. Nothing here is a product hook: the api and the web app
 * are started exactly as an operator would start them, pointed at a seeded
 * database.
 */

export const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/mentorship";
export const API_PORT = Number(process.env["E2E_API_PORT"] ?? 18787);
export const WEB_PORT = Number(process.env["E2E_WEB_PORT"] ?? 13000);
export const API_ORIGIN = `http://localhost:${API_PORT}`;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

/** Must match `SESSION_COOKIE` in `apps/api/src/server.ts`. */
export const SESSION_COOKIE = "mentorship_session";

export interface Seed {
  /** The org apps/api and apps/web are both configured for. */
  orgA: string;
  userA: string;
  adminEmail: string;
  /** A second, foreign org — never configured anywhere, only guessed at. */
  orgB: string;
  userB: string;
  riskSummary: string;
  orgBRiskSummary: string;
  orgBFolderId: string;
  nudgeBody: string;
  stuckSubjectRef: string;
  deadLetterError: string;
  /** The display name of the participant who changed a seeded pair's cadence. */
  preferenceChangedBy: string;
  matchingRunId: string;
  matchingMenteeId: string;
  matchingWinnerMentorId: string;
  matchingLoserMentorId: string;
  /** Where the api process's stdout is written — the magic-link seam. */
  apiLogPath: string;
}

export function seed(): Seed {
  const raw = process.env["E2E_SEED"];
  if (!raw) throw new Error("E2E_SEED is not set — run through playwright.config.ts");
  return JSON.parse(raw) as Seed;
}

let client: Sql | undefined;

/** One superuser connection per worker, for seeding and for asserting rows. */
export function db(): Sql {
  client ??= postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  return client;
}

/**
 * A session row inserted directly — for specs that are about something other
 * than logging in. The magic-link spec is the one place that earns a session
 * the real way, through the browser.
 */
export async function createSession(orgId: string, userId: string): Promise<string> {
  const [row] = await db()<{ id: string }[]>`
    insert into auth_sessions (org_id, user_id, expires_at)
    values (${orgId}, ${userId}, now() + interval '1 day')
    returning id`;
  return row!.id;
}

export async function signIn(
  context: BrowserContext,
  orgId: string,
  userId: string,
): Promise<void> {
  const sessionId = await createSession(orgId, userId);
  await context.addCookies([
    { name: SESSION_COOKIE, value: sessionId, url: WEB_ORIGIN, httpOnly: true, sameSite: "Lax" },
  ]);
}

/**
 * `magic_links` holds only `sha256(token)` (see `hashToken` in
 * `packages/auth/src/magic-link.ts`), so the raw token cannot be read back
 * out of the database — by design. The only place it exists is the line
 * `apps/api/src/main.ts`'s `onMagicLinkIssued` prints, which the global setup
 * captures to a file. Polls, because the print races the HTTP response.
 */
export async function readMagicLinkToken(email: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const prefix = `[auth] magic link for ${email}: `;
  for (;;) {
    const log = await readFile(seed().apiLogPath, "utf8");
    const lines = log.split("\n").filter((line) => line.startsWith(prefix));
    const last = lines.at(-1);
    if (last) return last.slice(prefix.length).trim();
    if (Date.now() > deadline) throw new Error(`no magic link printed for ${email}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function apiLogMentions(needle: string): Promise<boolean> {
  return (await readFile(seed().apiLogPath, "utf8")).includes(needle);
}
