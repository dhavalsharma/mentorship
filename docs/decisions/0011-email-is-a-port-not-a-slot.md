# ADR-0011: Outbound email is a port bound from the environment, not a ninth slot

**Status:** Accepted
**Date:** 2026-09-29
**Deciders:** dhaval (WeKan.AI)

## Context

Sign-in links and cohort invites were printed to the api's log, because there
was nothing to send them with. Sending them is the last step before anyone
outside the team can use the dashboard.

Everything else this repo sends to a person goes through an adapter bound to a
*slot* (`conversation`, `dm`, `calendar`, ...): per-tenant rows in
`integration_bindings`, resolved by the worker, probed for capabilities
(ADR-0006), wrapped in `SandboxGuard` on the live path. The obvious move was a
ninth slot, `email`.

Two facts argue against it. The mail is sent by `apps/api`, which holds no
adapters and no registry — CLAUDE.md records that as the reason "re-probe on
settings save" was rejected. And it is not program tooling a tenant chooses:
it is the mail a person needs *before* they can reach anything a program
configured, sent from one address the deployment owns.

## Decision

`EmailSender` (`packages/core/src/capabilities.ts`) is a vendor-agnostic port
with one method, `send({ to, subject, text, html?, idempotencyKey })`. It is
**not** an `Adapter`: no slot, no `probe()`, no `integration_bindings` row.
`GmailEmailAdapter` implements it, `FakeEmail` fakes it, and `apps/api`
builds one from the environment (`email-config.ts`) and hands it to the
existing `onMagicLinkIssued` seam.

Unset, there is no sender and the api prints the link as it always did (local
dev, tests, the browser suite reads that line). Set but incomplete, the api
refuses to start rather than falling back to printing tokens.

## Options considered

- **A ninth `email` slot, per-tenant.** Rejected for the two reasons above,
  and because a per-tenant sender means the *sign-in* email of org A could
  come from org B's mailbox depending on how a lookup went, before a session
  exists to say which org this is. Revisit if a tenant ever needs its own
  From address: the port does not change, only where the sender is resolved.
- **SMTP through a mail library.** Rejected: a new dependency and a credential
  type (an app password) this repo has no other use for, when the Google
  credentials and refresh flow already exist and are tested
  (`GoogleAccessTokenSource`).
- **A transactional provider now (SES, Postmark, Resend).** Better
  deliverability and no per-day cap, and the right answer at volume. Not done
  because it needs a domain, DNS and an account before a pilot can run, and
  because the port makes it a later swap of one class. `docs/email-setup.md`
  says when.
- **Domain-wide delegation from a service account.** Works for Workspace and
  avoids a refresh token that expires; documented as the alternative, not
  built, because it cannot be tested here and the repo's own live-testing
  guidance calls delegation "the wrong tool for a test".

## Consequences

- Gmail has no idempotency key, so `idempotencyKey` is honoured only by the
  fake. The real sender remembers keys in-process and derives `Message-ID`
  from the key; a retry across a restart, or after an ambiguous timeout, can
  double-send. The seam therefore does not retry: a lost link is one more
  click on "email me a link".
- Email is the loudest thing this repo can do to a stranger, and it is not a
  slot, so `guardAdapter` never sees it. `guardEmailSender` applies the same
  allowlist, whenever `SANDBOX_ALLOWLIST` is set.
- Every mail is From one address per deployment. Per-tenant branding or From
  is a follow-up, not a regression.
- Calendar invitations are unrelated and unchanged: they go through
  `GoogleCalendarAdapter` (`sendUpdates: "none"` in live tests), not this port.
- **Mail-bomb and quota exhaustion, and what limits it.** `/auth/request-link`
  is unauthenticated and now costs a real mail per request for a known
  address. `createMagicLinkDelivery` therefore keeps a per-address cooldown
  (`MAGIC_LINK_EMAIL_COOLDOWN_SECONDS`, default 60, `0` = off), separate for
  sign-in and invite so a flood cannot swallow an admin's invite. Inside the
  window the link is still minted and valid but **not mailed**; the response
  is byte-identical, and a non-address-bearing `magic_link_email_cooldown`
  warning is logged. Only a send that succeeded starts the window: a
  rejected send (including a sandbox refusal, which never reaches Gmail and
  so spends no quota) releases its slot, so the person's retry is mailed at
  once. Nothing resends on its own, so after a failed send somebody must
  ask again (a sign-in request, or an admin re-invite); an invite is
  delayed until they do, not lost, and is never silently suppressed by a
  failure. The table is bounded (10 000
  entries; expired first, then the oldest, so it cannot be a memory lever).
  **Residual risk, accepted:** the map is in-process, so N api processes each
  allow one mail per window, and a restart forgets it; an attacker who knows
  many valid addresses can still spread the quota; and there is no per-IP
  limit. A shared limit (Postgres row, or a proxy/WAF rule on
  `/auth/request-link`) is the follow-up and should be in place at scale.
- **Logs.** The mail path never logs a token or a link. It logs no
  recipient address either: a `SandboxRefusal` names the recipient, so the
  failure report replaces it with `[address]` and the boot-time refusal
  warning prints `***@domain`. The one exception is the no-sender fallback,
  which prints the address and token by design (local dev).
- **Expiry** is one constant, `MAGIC_LINK_TTL_MINUTES` (`packages/auth`), used
  by the store and by the wording, so the mail cannot state another value. An
  invite mail says what to do after it expires (ask to be invited again, or
  request a sign-in link).
