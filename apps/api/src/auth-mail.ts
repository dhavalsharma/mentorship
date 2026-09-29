import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailSender } from "@mentorship/core";
import type { MagicLinkContext } from "./server.js";

/**
 * The `onMagicLinkIssued` seam, turned into mail — or, when no sender is
 * configured, into exactly the printed line it has always been.
 *
 * The seam is synchronous and `void`, and stays that way: the route calls it
 * *after* it has decided the response and never looks at the result. So the
 * send is started and not awaited. That is what keeps `/auth/request-link`
 * byte-identical — and, as far as a stopwatch can tell, equally fast — for a
 * known and an unknown email: the only difference between them is whether
 * this function is called at all, and a call that returns immediately (the
 * send runs on the next tick) adds nothing an attacker can time. A failed
 * send goes to `onUnhandled`, never to the requester.
 *
 * Nothing retries. A lost sign-in mail costs the person one more click on
 * "email me a link"; a retry on top of a vendor with no idempotency key (see
 * `GmailEmailAdapter`) would cost a duplicate. That trade is deliberate.
 */

export interface MagicLinkDeliveryOptions {
  /** Null = no sender configured: print the link, as `pnpm serve:api` always did. */
  sender: EmailSender | null;
  /** Where `apps/web` is served, e.g. `https://app.example.org`. Required with a sender. */
  appBaseUrl: string | null;
  onUnhandled: (reason: string, detail: Record<string, unknown>) => void;
  /** Where the fallback line and the sent-confirmation go. Defaults to `console.log`. */
  log?: (line: string) => void;
  ttlMinutes?: number;
}

export function createMagicLinkDelivery(
  options: MagicLinkDeliveryOptions,
): (email: string, rawToken: string, context?: MagicLinkContext) => void {
  const log = options.log ?? ((line: string) => console.log(line));

  if (options.sender === null) {
    // Local dev, tests and the browser suite. `apps/web/e2e/support.ts` reads
    // this exact line from the api's stdout — do not reword it.
    return (email, rawToken) => {
      log(`[auth] magic link for ${email}: ${rawToken}`);
    };
  }

  const { sender } = options;
  const base = options.appBaseUrl;
  if (base === null) {
    throw new Error("createMagicLinkDelivery: a sender needs appBaseUrl to build the link");
  }

  return (email, rawToken, context) => {
    // Everything, including composing, happens after this call returns.
    void Promise.resolve()
      .then(async () => {
        const link = magicLinkUrl(base, rawToken);
        const message = composeAuthEmail({
          to: email,
          link,
          context: context ?? { kind: "sign_in" },
          ...(options.ttlMinutes !== undefined ? { ttlMinutes: options.ttlMinutes } : {}),
        });
        const { messageRef } = await sender.send({
          ...message,
          idempotencyKey: `auth-mail:${randomUUID()}`,
        });
        // No address, no token, no link: which mailbox a sign-in went to is
        // not something an operator log needs.
        log(`[auth] ${(context ?? { kind: "sign_in" }).kind} email sent (${messageRef})`);
      })
      .catch((error: unknown) => {
        options.onUnhandled("magic_link_email_failed", {
          kind: (context ?? { kind: "sign_in" }).kind,
          error: scrub(error, [rawToken, encodeURIComponent(rawToken)]),
        });
      });
  };
}

export function magicLinkUrl(appBaseUrl: string, rawToken: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/verify?token=${encodeURIComponent(rawToken)}`;
}

/** A failure message that can never carry the credential it was sent with. */
function scrub(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join("[token]");
  }
  return message.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const PRODUCT = "Mentorship";

/**
 * A name typed by an admin (an inviter's display name, a cohort name) is
 * headed for a Subject line. Collapse any whitespace run, line breaks
 * included, to one space so an odd name cannot make the whole mail fail —
 * `buildMimeMessage` still refuses a real CR/LF as the backstop.
 */
function plain(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 100);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function composeAuthEmail(input: {
  to: string;
  link: string;
  context: MagicLinkContext;
  ttlMinutes?: number;
}): EmailMessage {
  const ttl = input.ttlMinutes ?? 15;
  const expiry = `The link works once and expires in ${ttl} minutes.`;
  const ignore = "If you were not expecting this, you can ignore this email.";

  if (input.context.kind === "invite") {
    const inviter = plain(input.context.inviterName);
    const cohort = plain(input.context.cohortName);
    const program = plain(input.context.programName);
    const role = plain(input.context.role);
    const lead = `${inviter} invited you to join ${cohort} (${program}) as ${role}.`;
    return {
      to: input.to,
      subject: `${inviter} invited you to ${cohort} on ${PRODUCT}`,
      text: [lead, "", "Follow this link to accept and sign in:", input.link, "", expiry, ignore].join("\n"),
      html:
        `<p>${escapeHtml(lead)}</p>` +
        `<p><a href="${escapeHtml(input.link)}">Accept the invitation and sign in</a></p>` +
        `<p>${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>`,
    };
  }

  return {
    to: input.to,
    subject: `Your ${PRODUCT} sign-in link`,
    text: [`Use this link to sign in to ${PRODUCT}:`, input.link, "", expiry, ignore].join("\n"),
    html:
      `<p>Use this link to sign in to ${PRODUCT}:</p>` +
      `<p><a href="${escapeHtml(input.link)}">Sign in</a></p>` +
      `<p>${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>`,
  };
}
