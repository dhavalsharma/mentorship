import { createHash } from "node:crypto";
import { z } from "zod";
import type { EmailMessage, EmailSender } from "@mentorship/core";
import { staticAccessToken, type GoogleAccessTokenSource } from "./auth.js";
import { assertAddress, buildMimeMessage, toBase64Url } from "../email/mime.js";

/**
 * Gmail API sender — `users.messages.send` — for sign-in and invite mail.
 *
 * STATUS: API shapes real, from the documentation; **not run against a live
 * account**. The token needs `https://www.googleapis.com/auth/gmail.send` and
 * nothing more: that scope can send, and cannot read, list or delete mail.
 *
 * Not a calendar adapter and unrelated to `GoogleCalendarAdapter`: calendar
 * invitations still go through Calendar with `sendUpdates: "none"`.
 *
 * Two things Gmail does that a caller could get wrong:
 *
 *   - It sends *as the authenticated mailbox*. A `From` that is not that
 *     mailbox, or one of its configured send-as aliases, is silently rewritten
 *     to the mailbox. So `GMAIL_SENDER_ADDRESS` must be the mailbox the
 *     refresh token belongs to (or a verified alias of it).
 *   - It has **no idempotency key**. `messages.send` does not take one, and
 *     unlike Drive there is nowhere to tag the result for a later lookup. A
 *     retry after a timeout that actually delivered will send twice. The
 *     `idempotencyKey` in `EmailSender.send` therefore buys two weaker things
 *     only: an in-process memory of keys already sent (so a same-process
 *     retry is a no-op — lost on restart), and a `Message-ID` derived from the
 *     key, which lets a mail client that dedupes on it collapse a duplicate.
 *     Neither is a guarantee, and nothing here relies on one: the auth seam
 *     sends once and never retries.
 */

export const GmailConfigSchema = z.object({
  /** The mailbox the token authorises, or a verified send-as alias of it. */
  senderAddress: z.string().min(3),
  senderName: z.string().min(1).optional(),
  replyTo: z.string().min(3).optional(),
});
export type GmailConfig = z.infer<typeof GmailConfigSchema>;

export type GmailTransport = (
  path: string,
  init: { method: string; body?: unknown },
) => Promise<Record<string, unknown>>;

/** Same shape as the Calendar transport: bearer token per request, throw on a non-2xx. */
export function httpGmailTransport(
  accessToken: string | GoogleAccessTokenSource,
): GmailTransport {
  const getToken = typeof accessToken === "string" ? staticAccessToken(accessToken) : accessToken;
  return async (path, init) => {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${await getToken()}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      // The request body (the message, and so the sign-in link) is never
      // part of this error — only Google's own reply is.
      throw new Error(`google gmail ${path} failed: ${JSON.stringify(json)}`);
    }
    return json;
  };
}

/** Bounded, so a long-lived API process cannot grow it without limit. */
const REMEMBERED_KEYS = 1000;

export class GmailEmailAdapter implements EmailSender {
  readonly id = "gmail";
  private readonly sent = new Map<string, string>();
  private readonly config: GmailConfig;

  constructor(
    private readonly call: GmailTransport,
    config: GmailConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = GmailConfigSchema.parse(config);
    // Fail at construction, not on the first sign-in attempt of the day.
    assertAddress("sender address", this.config.senderAddress);
    if (this.config.replyTo !== undefined) assertAddress("reply-to", this.config.replyTo);
  }

  async send(
    input: EmailMessage & { idempotencyKey: string },
  ): Promise<{ messageRef: string }> {
    const remembered = this.sent.get(input.idempotencyKey);
    if (remembered !== undefined) return { messageRef: remembered };

    const domain = this.config.senderAddress.split("@")[1]!;
    const messageId = `${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}@${domain}`;
    const message = buildMimeMessage({
      from: {
        address: this.config.senderAddress,
        ...(this.config.senderName !== undefined ? { name: this.config.senderName } : {}),
      },
      to: input.to,
      ...(this.config.replyTo !== undefined ? { replyTo: this.config.replyTo } : {}),
      subject: input.subject,
      text: input.text,
      ...(input.html !== undefined ? { html: input.html } : {}),
      date: this.now(),
      messageId,
    });

    const res = await this.call("/users/me/messages/send", {
      method: "POST",
      body: { raw: toBase64Url(message) },
    });
    const id = typeof res["id"] === "string" ? res["id"] : messageId;
    this.sent.set(input.idempotencyKey, id);
    if (this.sent.size > REMEMBERED_KEYS) {
      this.sent.delete(this.sent.keys().next().value as string);
    }
    return { messageRef: id };
  }
}
