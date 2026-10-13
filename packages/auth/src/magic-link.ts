import { randomBytes, createHash } from "node:crypto";

/**
 * Port for the two tables this flow touches, declared locally rather than
 * imported from a driver package — the same reasoning
 * `packages/primitives/matching/src/round.ts` gives for `MatchingCommitSink`,
 * except here there is no existing driver package to invert away from: the
 * point is just to keep this logic testable with a Map-based fake and no
 * real database, so a change to how Postgres is queried never touches a test.
 */
export interface MagicLinkStore {
  findUserByEmail(
    orgId: string,
    email: string,
  ): Promise<{ userId: string } | null>;
  createLink(input: {
    orgId: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void>;
  findUnconsumedLinkByTokenHash(
    orgId: string,
    tokenHash: string,
  ): Promise<{ userId: string; expiresAt: string; consumedAt: string | null } | null>;
  /**
   * Marks the link consumed and reports whether THIS call was the one that
   * did it — `false` means someone else (a concurrent request replaying the
   * same link) already had. The check-then-act gap between the lookup above
   * and this call is real: two requests can both see `consumedAt: null` and
   * both reach here, so the store must make consuming atomic (an `UPDATE
   * ... WHERE consumed_at IS NULL` and reporting whether a row was actually
   * touched), not just check-then-write. `verifyMagicLink` trusts this
   * return value as the actual source of truth for one-time use, not the
   * earlier lookup.
   */
  consumeLink(orgId: string, tokenHash: string): Promise<boolean>;
  createSession(input: {
    orgId: string;
    userId: string;
    expiresAt: string;
  }): Promise<{ sessionId: string }>;
  findActiveSession(
    orgId: string,
    sessionId: string,
  ): Promise<{ userId: string; expiresAt: string; revokedAt: string | null } | null>;
}

/**
 * Out of scope, deliberately, for this first pass:
 *  - rate limiting requests per email/IP — a caller-side concern, and one
 *    that needs a shared store this package does not own.
 *  - actually sending an email — `requestMagicLink` only ever returns the raw
 *    token to its caller, the same way `apps/worker/src/seed-live-pair.ts`
 *    prints an id for a human to use manually rather than sending anything.
 *  - session revocation on logout — the schema already has `revokedAt` for
 *    it, but no function sets it yet. A natural one-line follow-up, not
 *    required for login to work.
 */

/** 256 bits, hex-encoded. Hex over base64url purely so it is trivially
 * pasteable into a URL query param or a manual test without escaping. */
function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The raw token is the bearer credential — anyone holding it can log in as
 * the user until it expires or is used. It must never be persisted anywhere,
 * including logs: only its hash is written to `magic_links.token_hash`, so a
 * leaked database dump (backup, replica, `pg_dump`) cannot be used to log in
 * as anyone. sha256 is sufficient here because the input is already 256 bits
 * of CSPRNG output — this is not a password hash guarding a human-guessable
 * secret, so no salt or slow KDF is needed.
 */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export type RequestMagicLinkResult =
  | { requested: true; rawToken: string }
  | { requested: true; rawToken: null };

/**
 * How long a magic link lives. One exported value, because the email that
 * carries the link states it: `apps/api`'s `composeAuthEmail` reads this same
 * constant, so the mail can never promise a different expiry than the store
 * enforces.
 */
export const MAGIC_LINK_TTL_MINUTES = 15;

/**
 * Looks up the user by their email (trimmed and lowercased, the form every
 * writer stores), and — only if one exists — creates a link and returns its
 * raw token.
 *
 * Enumeration safety: the shape returned to an HTTP-facing caller must not
 * let an attacker distinguish "that email has an account" from "it doesn't"
 * by timing, response shape, or content. So this always returns
 * `{ requested: true, rawToken }`, with `rawToken` either the real token or
 * `null` for an unknown email — never an error, never a different field set,
 * never a different code path taken. A caller with legitimate access to the
 * result (a test, an admin tool, the HTTP handler that will actually deliver
 * the email) reads `rawToken` when it wants to act; anything facing the
 * requester discards `rawToken` entirely and always renders the same
 * generic "if that email exists, we sent a link" message. The `requested:
 * true` discriminant exists so a future non-enumeration-safe caller (e.g. an
 * internal admin "resend" tool) can be typed differently rather than by
 * accident.
 */
export async function requestMagicLink(input: {
  store: MagicLinkStore;
  orgId: string;
  email: string;
  now: () => Date;
  ttlMinutes?: number;
}): Promise<RequestMagicLinkResult> {
  const { store, orgId, now, ttlMinutes = MAGIC_LINK_TTL_MINUTES } = input;
  // Every writer of `users.email` — a staff grant, an invite, a roster
  // import — stores it trimmed and lowercased, so the lookup has to ask in
  // the same form, or someone granted as `Grace@Example.com` who types it
  // that way at /login silently gets no link (and, by design, no hint why).
  // Here rather than in each store so every store benefits. It changes only
  // *which* row is found, never the shape returned: an unknown email still
  // takes the same path to the same `rawToken: null`.
  const email = input.email.trim().toLowerCase();
  const user = await store.findUserByEmail(orgId, email);
  if (user === null) {
    return { requested: true, rawToken: null };
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now().getTime() + ttlMinutes * 60_000).toISOString();

  await store.createLink({
    orgId,
    userId: user.userId,
    tokenHash,
    expiresAt,
  });

  return { requested: true, rawToken };
}

export type VerifyMagicLinkFailureReason = "not_found" | "expired" | "already_used";

/**
 * `userId` is carried on success so a caller can act on *who* just signed in
 * — `apps/api` accepts their pending cohort invites — without a second trip
 * through `verifySession` for a session it minted a line earlier.
 */
export type VerifyMagicLinkResult =
  | { ok: true; sessionId: string; userId: string; expiresAt: string }
  | { ok: false; reason: VerifyMagicLinkFailureReason };

/**
 * Hashes the incoming raw token, looks it up, and — if it is unconsumed and
 * unexpired — consumes it (one-time use) and issues a new session.
 *
 * Failure is a discriminated reason rather than a bare boolean so a caller
 * can log or respond differently for, say, an already-used link (possible
 * replay or double-click) versus an expired one (just resend).
 */
export async function verifyMagicLink(input: {
  store: MagicLinkStore;
  orgId: string;
  rawToken: string;
  now: () => Date;
  sessionTtlMinutes?: number;
}): Promise<VerifyMagicLinkResult> {
  const { store, orgId, rawToken, now, sessionTtlMinutes = 60 * 24 * 7 } = input;
  const tokenHash = hashToken(rawToken);

  const link = await store.findUnconsumedLinkByTokenHash(orgId, tokenHash);
  if (link === null) {
    return { ok: false, reason: "not_found" };
  }
  if (new Date(link.expiresAt).getTime() <= now().getTime()) {
    return { ok: false, reason: "expired" };
  }

  // The lookup above is only an optimistic check — `consumeLink`'s return
  // value is the actual, race-safe answer to "did this call get to use it."
  // A concurrent replay of the same link loses here even if it also passed
  // the checks above.
  const consumed = await store.consumeLink(orgId, tokenHash);
  if (!consumed) {
    return { ok: false, reason: "already_used" };
  }

  const expiresAt = new Date(
    now().getTime() + sessionTtlMinutes * 60_000,
  ).toISOString();
  const { sessionId } = await store.createSession({
    orgId,
    userId: link.userId,
    expiresAt,
  });

  return { ok: true, sessionId, userId: link.userId, expiresAt };
}

export type VerifySessionFailureReason = "not_found" | "expired" | "revoked";

export type VerifySessionResult =
  | { ok: true; userId: string }
  | { ok: false; reason: VerifySessionFailureReason };

export async function verifySession(input: {
  store: MagicLinkStore;
  orgId: string;
  sessionId: string;
  now: () => Date;
}): Promise<VerifySessionResult> {
  const { store, orgId, sessionId, now } = input;
  const session = await store.findActiveSession(orgId, sessionId);
  if (session === null) {
    return { ok: false, reason: "not_found" };
  }
  if (session.revokedAt !== null) {
    return { ok: false, reason: "revoked" };
  }
  if (new Date(session.expiresAt).getTime() <= now().getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, userId: session.userId };
}
