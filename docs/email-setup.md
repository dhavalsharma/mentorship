# Sending sign-in and invite email through Google Cloud

Magic-link sign-in emails and cohort invite emails are sent through the Gmail
API (`users.messages.send`) when `GMAIL_SENDER_ADDRESS` is set. Unset, the api
prints the link to its log instead, which is what local development, the test
suite and `pnpm test:browser` rely on. The design and what was rejected are in
[ADR-0011](./decisions/0011-email-is-a-port-not-a-slot.md).

**Not covered here:** calendar invitations. Those go through
`GoogleCalendarAdapter` (Calendar API, `sendUpdates: "none"` in live tests) and
are unaffected — the two share a Google project and a refresh-token flow, not
code paths.

**Status: not run against a live account.** The Gmail adapter's request shape
is from Google's documentation and a hand-written fixture. Step 10 is the first
time it meets the real API; treat a failure there as information about the
adapter, not just your setup.

Read [live-tenant-testing.md](./live-tenant-testing.md) first: the Google
project, consent screen and OAuth client below are the same ones it creates.

---

## Setup

1. **Create or select a Google Cloud project.**
   [console.cloud.google.com](https://console.cloud.google.com) → project
   picker → *New project*, or reuse the project from the Calendar/Drive setup.
   Reusing it is fine and simpler: one OAuth client, one consent screen.

2. **Enable the Gmail API.** APIs & Services → Library → *Gmail API* →
   *Enable*.

3. **Configure the OAuth consent screen** (APIs & Services → OAuth consent
   screen), if the project does not have one yet.
   - **Internal** if the sender mailbox is in a Google Workspace you control
     and every user of the app is in it. No verification, no test-user list,
     no 7-day refresh-token expiry.
   - **External** otherwise. Publishing status **Testing** caps the app at 100
     test users, and while it is in Testing Google expires a refresh token
     after 7 days. Add the *sender* mailbox under **Test users**. Moving to
     **In production** removes the expiry; the `gmail.send` scope is
     classified *sensitive*, so an unverified production app shows an
     "unverified app" warning on authorize (fine for one operator authorizing
     their own mailbox once) and needs Google verification to be used by the
     public — which it is not, since only the sender ever authorizes it.

4. **Choose the scope: `https://www.googleapis.com/auth/gmail.send` only.**
   Least privilege: this scope can send mail as the mailbox and cannot read,
   list, modify or delete anything in it. Do not add `gmail.readonly`,
   `gmail.modify` or `https://mail.google.com/`. If you also run the Calendar
   or Drive adapters off the same refresh token, the token needs *their*
   scopes too — but a token minted for those alone gets `403 Request had
   insufficient authentication scopes` on the first send (the recorded
   fixture `messages.send--error-insufficient-scope`).

5. **Create the OAuth client.** Credentials → *Create credentials* → *OAuth
   client ID* → *Desktop app* (or reuse the one from live-tenant-testing.md).
   Copy the client id and secret. Never commit them; they go in `.env`
   (gitignored).

6. **Pick the sender mailbox.** Gmail sends *as the authorized mailbox*. Use a
   dedicated address (`noreply@your-domain`, `mentorship@your-domain`) rather
   than a person's inbox: it will accumulate bounces and replies. That mailbox
   is the account you sign in as in step 7.
   - A `From` address that is not the mailbox, or one of its verified *Send
     mail as* aliases (Gmail → Settings → Accounts), is silently rewritten by
     Gmail to the mailbox. Set `GMAIL_SENDER_ADDRESS` to the mailbox, or to a
     verified alias.
   - Set `GMAIL_REPLY_TO` if replies should go somewhere monitored.

7. **Obtain a refresh token.** No callback server needed — the OAuth 2.0
   Playground, as in live-tenant-testing.md:
   [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
   → gear icon → *Use your own OAuth credentials* → paste the client id and
   secret → set **Access type: Offline** and tick **Force approval prompt** →
   in the scope box enter `https://www.googleapis.com/auth/gmail.send` →
   *Authorize APIs*, signing in **as the sender mailbox** → *Exchange
   authorization code for tokens*. Copy the **refresh token** (not the access
   token, which lasts an hour).
   The Playground is the only tool this repo uses for this. A dependency-free
   script would be easy to write and is deliberately not added: it would be one
   more place a client secret can be pasted, for a step done once.

   *Alternative for Google Workspace: domain-wide delegation.* A service
   account with delegation can send as a mailbox in your domain with no
   refresh token to expire. It is **not implemented** — it needs a JWT-signing
   token source alongside `GoogleAccessTokenSource` and cannot be tested here
   — and a service account with delegation can impersonate anyone in the
   domain, which live-tenant-testing.md advises against for tests. If you want
   it, the change is one new `GoogleAccessTokenSource`; nothing else moves.

8. **Set the environment** for `pnpm serve:api` (`.env`, never committed):

   ```bash
   GMAIL_SENDER_ADDRESS=mentorship@your-domain.example   # setting this turns sending on
   GMAIL_SENDER_NAME=Mentorship                          # optional display name
   GMAIL_REPLY_TO=help@your-domain.example               # optional
   APP_BASE_URL=https://app.your-domain.example          # where apps/web is served; the link is $APP_BASE_URL/verify?token=…
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   GOOGLE_REFRESH_TOKEN=…            # or GOOGLE_ACCESS_TOKEN for a one-off (expires in an hour)
   SANDBOX_ALLOWLIST=you@your-domain.example   # testing only; see below — UNSET in production
   MAGIC_LINK_EMAIL_COOLDOWN_SECONDS=60        # optional; default 60, 0 = off; see "What sending guarantees"
   ```

   `APP_BASE_URL` must be `https` unless it is `localhost`: the token is in
   the URL. If `GMAIL_SENDER_ADDRESS` is set and anything else needed is
   missing, `pnpm serve:api` exits at boot with the reason — it will not fall
   back to printing tokens.

9. **The sandbox allowlist.** If `SANDBOX_ALLOWLIST` is set, mail to any
   address not on it is refused before a request is made (`SandboxRefusal`,
   logged as `magic_link_email_failed` with the address replaced by `[address]`;
   the person requesting sees the normal response). At boot the api prints a
   loud `EMAIL ALLOWLIST ACTIVE` line whenever it is set — if you see it in
   production, that is the bug. `.env.example` ships the variable commented
   out for the same reason. Entries are matched case-insensitively; Slack ids in the same
   list are ignored for email. Set it while testing so a stray address in a
   roster cannot receive a real sign-in link; **leave it unset in
   production**, where the allowlist would refuse everyone.

10. **Verify.**
    - Start the api with the variables above, against a database whose org has
      a user with *your* address (`pnpm staff:grant --email you@… --role
      admin`).
    - `curl -X POST localhost:8787/auth/request-link -H 'content-type:
      application/json' -d '{"email":"you@your-domain.example"}'` → the
      response is `{"requested":true}` whatever happens. Check the inbox (and
      spam). The api log says `sign_in email sent (<gmail message id>)` — no
      address, no link.
    - Failure shows only in the api log, as `[auth] magic_link_email_failed`
      with Google's own error: `insufficient authentication scopes` (token
      lacks `gmail.send`), `invalid_grant` (refresh token expired or revoked;
      redo step 7), `Precondition check failed` (Gmail not enabled or the
      mailbox cannot send).
    - For an invite, use the dashboard's *Invites* page for an address you
      control; the mail says who invited you, the cohort, the program and the
      role. Inviting again re-sends.
    - `pnpm test:contracts:live` includes a Gmail block when
      `GMAIL_SENDER_ADDRESS` is set: it sends one message with a dead link to
      the first email on `SANDBOX_ALLOWLIST` and refuses another. It has never
      been run; see [vendor-contracts.md](./vendor-contracts.md).

---

## Deliverability

Mail sent through Gmail from your own domain's mailbox is signed with your
domain's DKIM key **only if you have set that up in Workspace admin**; without
it, recipients see `via gmail.com` or a spam-folder landing.

- **SPF** — publish a TXT record on the sending domain that includes Google:
  `v=spf1 include:_spf.google.com ~all`.
- **DKIM** — Workspace admin → Apps → Google Workspace → Gmail → *Authenticate
  email* → generate the key, publish the TXT record it gives, *Start
  authentication*.
- **DMARC** — publish `_dmarc.<domain>` TXT, starting at `v=DMARC1; p=none;
  rua=mailto:you@<domain>` to watch reports, and tighten to `quarantine` once
  SPF and DKIM pass.
- A sign-in link in a message from an unknown sender is exactly what spam
  filters distrust. Keep the copy short and plain, send only in response to a
  person's own action (this does), and warm the address up on real users
  before an all-hands invite.

## Limits, and when to stop using this

Gmail API sending is capped per account per day — roughly **500 recipients a
day for a regular Gmail account and about 2,000 for Workspace** (Google
changes these; check the current [sending limits](https://support.google.com/a/answer/166852))
— and it counts against the mailbox, so a large invite wave and normal
sign-ins share one budget. Over the cap Gmail returns errors and the account
can be suspended for abuse-like patterns. That is fine for a pilot: a few
hundred people, one invite each, sign-ins as they happen.

Move to a transactional provider (SES, Postmark, Resend, SendGrid) when any of
these is true: an invite wave for a cohort larger than a few hundred; you need
delivery and bounce webhooks; you want the From address not to be a real
mailbox; or the refresh token's expiry becomes an operational chore. Because
`EmailSender` is a port, that is one new class implementing
`send({ to, subject, text, html?, idempotencyKey })` and a change in
`apps/api/src/email-config.ts` — the seam, the wording and the tests do not
move. (`buildMimeMessage` is vendor-neutral and reusable for an SMTP sender.)

## What sending guarantees, and does not

- **At most once per issued link, best effort.** The send starts after the
  response is decided and is never retried; a failure is logged, not shown.
- **A duplicate is possible** if something retries around an ambiguous
  failure: Gmail has no idempotency key. The adapter remembers keys in-process
  and derives `Message-ID` from the key, which is not a guarantee.
- **The response never depends on the send.** `/auth/request-link` returns the
  same bytes for a known email, an unknown one, and a known one whose send
  failed.
- **A cooldown limits mail-bombing, not eliminates it.** `/auth/request-link`
  is unauthenticated, so without a limit anyone could flood a known address's
  inbox and burn the mailbox's daily Gmail quota (about 500 recipients
  regular, 2000 Workspace), after which real sign-ins fail. The api sends at
  most one mail of a kind to one address per
  `MAGIC_LINK_EMAIL_COOLDOWN_SECONDS` (default 60). Inside the window the link
  is still issued and valid but no mail goes out (the response is unchanged;
  the log shows `magic_link_email_cooldown`, no address). Sign-in and invite
  have separate windows, and **a re-invite or a new sign-in request after the
  window sends again** — an invite is never lost, only delayed, and the invite
  mail tells the person to ask for a new one when the link expires. Residual
  risk: the map is per api process (N processes = N mails per window, restart
  forgets it), it is bounded at 10 000 addresses (oldest evicted), and there
  is **no per-IP limit** — put a rate limit on `/auth/request-link` at your
  proxy/WAF for anything public. See ADR-0011.
- **Links expire in 15 minutes** (`MAGIC_LINK_TTL_MINUTES`, the same constant
  the email states). An invitee opening the mail later gets a dead link and
  should use "email me a link" on the sign-in page, or ask to be re-invited.
- **The link is never logged** once a sender is configured, and neither is
  the recipient address (refusals log `***@domain`; failures show `[address]`). The printed
  `[auth] magic link for …` line exists only when no sender is.
