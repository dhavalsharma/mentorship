import { fileURLToPath } from "node:url";
import type { EmailSender } from "@mentorship/core";
import {
  fileFixtureSink,
  GmailEmailAdapter,
  guardEmailSender,
  httpGmailTransport,
  recordingGoogleGmailTransport,
  refreshableGoogleAccessToken,
  SandboxGuard,
  staticAccessToken,
  type GmailTransport,
  type GoogleAccessTokenSource,
} from "@mentorship/integrations";

/**
 * Environment -> the `EmailSender` `apps/api` mails sign-in and invite links
 * with. Kept out of `main.ts` so every rule below is a unit test.
 *
 * The switch is `GMAIL_SENDER_ADDRESS`. Unset, there is no sender and the api
 * prints links (local dev, tests, the browser suite). Set, everything else it
 * needs must be too, and a gap **throws at boot** rather than falling back to
 * printing: a half-configured deployment that quietly logs sign-in tokens is
 * worse than one that refuses to start.
 *
 * Credentials are the same three-variable refresh flow the worker's Google
 * adapters use (`GOOGLE_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`), preferred over
 * a static `GOOGLE_ACCESS_TOKEN`. The refresh token must have been granted
 * `gmail.send` — a token minted for Calendar/Drive alone is a 403 on the first
 * send (a recorded fixture, `messages.send--error-insufficient-scope`).
 */

export interface EmailEnv {
  GMAIL_SENDER_ADDRESS?: string | undefined;
  GMAIL_SENDER_NAME?: string | undefined;
  GMAIL_REPLY_TO?: string | undefined;
  APP_BASE_URL?: string | undefined;
  GOOGLE_ACCESS_TOKEN?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_REFRESH_TOKEN?: string | undefined;
  /** When set, mail to any address not on it is refused before the transport. */
  SANDBOX_ALLOWLIST?: string | undefined;
  CAPTURE_VENDOR_FIXTURES?: string | undefined;
  VENDOR_FIXTURE_DIR?: string | undefined;
}

export interface EmailSenderBuildOptions {
  /** Tests inject a transport; production leaves it unset and gets real HTTP. */
  transport?: GmailTransport;
  onRefused?: (detail: { adapter: string; refused: string[] }) => void;
}

const DEFAULT_VENDOR_FIXTURE_DIR = fileURLToPath(
  new URL("../../../tests/fixtures/vendor", import.meta.url),
);

/** Null when `GMAIL_SENDER_ADDRESS` is unset — the print-the-link fallback. */
export function buildGmailSender(
  env: EmailEnv,
  options: EmailSenderBuildOptions = {},
): { sender: EmailSender; capturedFixtures: string[] } | null {
  if (!env.GMAIL_SENDER_ADDRESS?.trim()) return null;

  const hasRefreshCreds =
    !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && !!env.GOOGLE_REFRESH_TOKEN;
  if (!env.GOOGLE_ACCESS_TOKEN && !hasRefreshCreds && !options.transport) {
    throw new Error(
      "GMAIL_SENDER_ADDRESS is set but there are no Google credentials — set " +
        "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN (or GOOGLE_ACCESS_TOKEN)",
    );
  }

  const token: GoogleAccessTokenSource = hasRefreshCreds
    ? refreshableGoogleAccessToken({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        refreshToken: env.GOOGLE_REFRESH_TOKEN!,
      })
    : staticAccessToken(env.GOOGLE_ACCESS_TOKEN ?? "");

  let transport = options.transport ?? httpGmailTransport(token);
  const sink =
    env.CAPTURE_VENDOR_FIXTURES === "1"
      ? fileFixtureSink(env.VENDOR_FIXTURE_DIR ?? DEFAULT_VENDOR_FIXTURE_DIR)
      : null;
  if (sink) {
    transport = recordingGoogleGmailTransport(transport, {
      sink,
      onWarn: (message, detail) => console.warn(`[capture] ${message}`, detail ?? ""),
    });
  }

  let sender: EmailSender = new GmailEmailAdapter(transport, {
    senderAddress: env.GMAIL_SENDER_ADDRESS.trim(),
    ...(env.GMAIL_SENDER_NAME?.trim() ? { senderName: env.GMAIL_SENDER_NAME.trim() } : {}),
    ...(env.GMAIL_REPLY_TO?.trim() ? { replyTo: env.GMAIL_REPLY_TO.trim() } : {}),
  });

  // The same seatbelt the worker's live adapters wear. Unlike the worker,
  // the api does not *require* an allowlist — production has none — so the
  // guard is applied exactly when one is configured.
  if (env.SANDBOX_ALLOWLIST?.trim()) {
    const guard = new SandboxGuard({
      allowlist: env.SANDBOX_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),
      ...(options.onRefused ? { onRefused: options.onRefused } : {}),
    });
    sender = guardEmailSender(sender, guard);
  }

  return { sender, capturedFixtures: sink?.written ?? [] };
}

/**
 * The origin `apps/web` is served from, used to build the link in the mail.
 * https is required for anything that is not localhost: the token is in the
 * URL, and a link over plain http hands it to whoever is on the path.
 */
export function appBaseUrlFromEnv(env: Pick<EmailEnv, "APP_BASE_URL">): string | null {
  const raw = env.APP_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_BASE_URL is not a URL: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("APP_BASE_URL must be https (http is allowed only for localhost)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
