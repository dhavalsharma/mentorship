/**
 * Where a Google access token comes from.
 *
 * A Google OAuth access token expires after about an hour, always — that is
 * not a quirk of how this repo's setup docs get one, it is how the token
 * type works. Pasting one straight into `GOOGLE_ACCESS_TOKEN` (the original,
 * simplest path) means every call fails an hour after you fetched it, and
 * the only way back is redoing the OAuth Playground exchange by hand.
 *
 * `GoogleAccessTokenSource` is the seam that fixes that: a thunk the
 * transport calls before every request, rather than a string closed over
 * once at boot. `staticAccessToken` keeps the original behaviour for a quick
 * one-off test; `refreshableGoogleAccessToken` mints a fresh token from a
 * refresh token automatically, and is what `live-registry.ts` prefers when
 * the refresh credentials are present.
 */
export type GoogleAccessTokenSource = () => Promise<string>;

/** The original behaviour: one token, handed out forever. Expires like any other. */
export function staticAccessToken(token: string): GoogleAccessTokenSource {
  return async () => token;
}

export interface RefreshableGoogleTokenOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Seconds of safety margin refreshed before the token's own expiry. */
  refreshMarginSeconds?: number;
  fetch?: typeof fetch;
  /** Milliseconds since epoch. Injected so tests never sleep for real. */
  now?: () => number;
}

interface CachedToken {
  accessToken: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
}

/**
 * Exchanges a long-lived refresh token for a short-lived access token,
 * lazily and only when the cached one is missing or close to expiring —
 * never once per request. Google issues the same access token back for
 * several minutes if you ask again immediately, but there is no reason to
 * ask more than this needs to.
 *
 * The refresh token itself is not eternal either: with the OAuth consent
 * screen in "Testing" publishing status (this repo's default setup — see
 * docs/live-tenant-testing.md), Google expires an unused-for-refresh token
 * after 7 days. That turns "update this by hand every hour" into "every
 * week," which is the whole point, but it is not "never" — moving the
 * consent screen to "In production" (still unverified; that only adds a
 * warning screen on authorize) removes that limit for a small, known set of
 * testers.
 */
export function refreshableGoogleAccessToken(
  options: RefreshableGoogleTokenOptions,
): GoogleAccessTokenSource {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const marginMs = (options.refreshMarginSeconds ?? 60) * 1000;
  let cached: CachedToken | null = null;
  let pending: Promise<CachedToken> | null = null;

  async function refresh(): Promise<CachedToken> {
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      // A stale or revoked refresh token surfaces here as `invalid_grant` —
      // worth naming explicitly, since the fix (redo the OAuth exchange) is
      // different from every other failure this could otherwise look like.
      throw new Error(
        `google token refresh failed: ${json.error ?? res.status} ` +
          `${json.error_description ?? ""}`.trim(),
      );
    }
    return {
      accessToken: json.access_token,
      expiresAt: now() + (json.expires_in ?? 3600) * 1000,
    };
  }

  return async () => {
    if (cached && cached.expiresAt - marginMs > now()) {
      return cached.accessToken;
    }
    // Concurrent callers during a refresh share one in-flight request rather
    // than each firing their own — the cache is invalid for all of them at
    // once (every request needs a token right after boot), and Google has no
    // reason to see N simultaneous refresh calls for the same credential.
    if (!pending) {
      pending = refresh().finally(() => {
        pending = null;
      });
    }
    cached = await pending;
    return cached.accessToken;
  };
}
