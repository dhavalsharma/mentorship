import { describe, expect, it, vi } from "vitest";
import { refreshableGoogleAccessToken, staticAccessToken } from "../google/auth.js";

/**
 * The seam that turns "update GOOGLE_ACCESS_TOKEN by hand every hour" into
 * "the app refreshes it itself" — see `google/auth.ts`'s doc comment for the
 * full reasoning. No real network: `fetch` is always a fake here.
 */

function fakeTokenResponse(accessToken: string, expiresInSeconds = 3600) {
  return async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(
      JSON.stringify({ access_token: accessToken, expires_in: expiresInSeconds }),
      { status: 200 },
    );
}

describe("staticAccessToken", () => {
  it("always returns the same token it was given", async () => {
    const source = staticAccessToken("tok-1");
    expect(await source()).toBe("tok-1");
    expect(await source()).toBe("tok-1");
  });
});

describe("refreshableGoogleAccessToken", () => {
  it("fetches a token on first use, sending the refresh grant", async () => {
    const fetchSpy = vi.fn(fakeTokenResponse("access-1"));
    const source = refreshableGoogleAccessToken({
      clientId: "client-1",
      clientSecret: "secret-1",
      refreshToken: "refresh-1",
      fetch: fetchSpy,
    });

    expect(await source()).toBe("access-1");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init!.body as string);
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("secret-1");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("grant_type")).toBe("refresh_token");
  });

  it("reuses a cached token that is not close to expiring, without refetching", async () => {
    const fetchSpy = vi.fn(fakeTokenResponse("access-1", 3600));
    let clock = 0;
    const source = refreshableGoogleAccessToken({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      fetch: fetchSpy,
      now: () => clock,
    });

    expect(await source()).toBe("access-1");
    clock += 30 * 60_000; // 30 minutes in — well inside the 1-hour token
    expect(await source()).toBe("access-1");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("refreshes again once within the safety margin of expiry", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(fakeTokenResponse("access-1", 3600))
      .mockImplementationOnce(fakeTokenResponse("access-2", 3600));
    let clock = 0;
    const source = refreshableGoogleAccessToken({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      fetch: fetchSpy,
      now: () => clock,
      refreshMarginSeconds: 60,
    });

    expect(await source()).toBe("access-1");
    clock += 3600_000 - 30_000; // inside the 60s margin before expiry
    expect(await source()).toBe("access-2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const source = refreshableGoogleAccessToken({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      fetch: fetchSpy,
    });

    const first = source();
    const second = source();
    resolveFetch(
      new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), {
        status: 200,
      }),
    );

    expect(await first).toBe("access-1");
    expect(await second).toBe("access-1");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("throws a clear error naming the OAuth error on a failed refresh", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
          { status: 400 },
        ),
    );
    const source = refreshableGoogleAccessToken({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "revoked",
      fetch: fetchSpy,
    });

    await expect(source()).rejects.toThrow(/invalid_grant/);
  });
});
