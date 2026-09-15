# Testing against a real Slack and Google, without touching real users

Everything in this repo has been proved against fakes. That is worth something
and it is not the same as working. The Slack and Google adapters have never run
against a live tenant, and the only way to change that is to point them at one.

The risk is not exotic. This code posts messages, opens group DMs and creates
calendar invitations with `sendUpdates: "all"`, which means Google mails every
attendee before you can look at what you just wrote. It does not take a bug in
an adapter — one real email in a `pairings` row is enough.

So: three layers, strongest first. Do not rely on the third alone.

## 1. Isolate the workspace

**Slack: make a new workspace.** Not a private channel in the real one — a
separate free workspace, which takes about two minutes. The difference matters:
in a private channel, a bug can still reach a colleague, because the colleagues
are *there*. In a separate workspace nobody else exists, so there is nothing to
reach. It also avoids needing admin approval to install an app.

A pair needs two people, and the interesting part of the flow is precisely that
**both** have to accept. Plus-addressing gives you the second one:

| Role | Slack account |
| --- | --- |
| mentor | `dhavals+mentor@wekancode.com` |
| mentee | `dhavals+mentee@wekancode.com` |

Both deliver to the same inbox and Slack treats them as distinct users, so one
person can drive both sides of an agreement.

**Google: a dedicated calendar, not your primary.** Create a secondary calendar
on the test account and set `calendarId` to it. Invitations, conference links
and anything the saga creates land there, and your real calendar is untouched.
Use a test account — `dhavals@wekan.company` works as the second party if that
domain is yours — rather than a service account with domain-wide delegation,
which can impersonate anyone in the domain and is the wrong tool for a test.

## 2. Turn off the irreversible bit

```ts
new GoogleCalendarAdapter(httpGoogleTransport(token), {
  calendarId: "<the dedicated calendar id>",
  sendUpdates: "none",        // create the event, mail nobody
  transcriptEntitlement: "none",
});
```

`sendUpdates: "none"` still creates the event — you read it back from the API
to check the adapter worked. What it does not do is put anything in an inbox,
which is the part you cannot take back.

## 3. Wrap the adapters in the sandbox guard

```ts
import { SandboxGuard, guardAdapter } from "@mentorship/integrations";

const guard = new SandboxGuard({
  allowlist: (process.env["SANDBOX_ALLOWLIST"] ?? "").split(","),
  onRefused: ({ adapter, refused }) =>
    console.error(`[sandbox] ${adapter} refused: ${refused.join(", ")}`),
});

registry.bind(guardAdapter(slackConversation, guard));
registry.bind(guardAdapter(slackDm, guard));
registry.bind(guardAdapter(googleCalendar, guard));
```

Every recipient is checked before the call leaves the process, and anything not
on the list throws. It refuses rather than silently skipping, because a no-op
during a live test is indistinguishable from a broken adapter, and finding out
which one you have is the entire point of the exercise.

The guard covers the three slots that address a person: conversation, dm and
calendar. Transcript, document and the rest act on artefacts the pair already
owns.

## Credentials

Create the apps yourself and put the secrets in `.env`, which is gitignored.
Nothing in this repo should ever hold a token.

```
SLACK_BOT_TOKEN=xoxb-…
SLACK_SIGNING_SECRET=…
GOOGLE_ACCESS_TOKEN=…
GOOGLE_CALENDAR_ID=…
SANDBOX_ALLOWLIST=dhavals+mentor@wekancode.com,dhavals+mentee@wekancode.com,U-…,U-…
```

Slack bot scopes, and no more: `chat:write` to post, `im:write` for the private
feedback DMs, `mpim:write` for the per-pair group DM. Skip `users:read` — the
identity mapping is explicit and verified by design (ADR-0006), so nothing
needs to enumerate the directory.

## Reaching your laptop from Slack

Interactivity needs a public HTTPS URL. A tunnel to `pnpm serve:api` is enough:

```bash
pnpm serve:api                      # localhost:8787
cloudflared tunnel --url http://localhost:8787
```

Point the app's Interactivity Request URL at
`https://<tunnel>/slack/interactions`. Signature verification is already
implemented and already tested, and it is what makes exposing the endpoint
acceptable: an unverified interaction endpoint lets anyone book meetings for
anyone.

## What a first live run is actually checking

The fakes cannot be wrong about these, because they are not real:

- Does `conversations.open` return a channel a bot may post into?
- Does the Block Kit payload render, and does a click arrive at the endpoint
  with a signature that verifies against the raw body?
- Does a Google event created with an idempotency key as its id actually make a
  retry a no-op, rather than a second invitation?
- Is this account entitled to an automatic transcript at all? That depends on
  the Workspace edition and admin policy, which is why ADR-0006 probes it once
  per tenant instead of inferring it from "they use Google".

Expect the identity mapping to be the thing that breaks first. It usually is.
