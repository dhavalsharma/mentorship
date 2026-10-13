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

**This does not work for Google Drive.** If you also configure the running-doc
feature (below), sharing the doc with a plus-addressed email fails outright —
confirmed directly against the live Drive API:
`dhavals+mentor@wekancode.com` gets back `400 invalidSharingRequest
("Sorry, an internal error has occurred")`, while the exact same call with the
bare `dhavals@wekancode.com` succeeds. Drive has no separate account or ACL
identity for a plus-addressed alias the way Slack does; it only grants access
to a real, distinct Google account. `grantEditAccess` in
`GoogleDriveDocumentAdapter` is not the bug here — it is correctly calling the
API and Google's own service is the one refusing the address. If you want to
test the sharing step specifically, `MENTOR_EMAIL`/`MENTEE_EMAIL` need two
genuinely separate Google accounts; Slack can keep using plus-addressing
regardless, since the two identity schemes are independent.

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

Create the apps yourself and put the secrets in `.env` (copy `.env.example`,
which is tracked; `.env` itself is gitignored). Nothing in this repo should
ever hold a token.

```
SLACK_BOT_TOKEN=xoxb-…
SLACK_SIGNING_SECRET=…
GOOGLE_ACCESS_TOKEN=…
GOOGLE_CALENDAR_ID=…
GOOGLE_DRIVE_FOLDER_ID=…          # optional — the real running-doc adapter
GOOGLE_DRIVE_GUIDELINE_DOC_ID=…   # optional — template copied per pair
SANDBOX_ALLOWLIST=dhavals+mentor@wekancode.com,dhavals+mentee@wekancode.com,U-…,U-…
```

**Sign-in and invite email** is a separate, opt-in piece of this setup: the api
sends magic links and cohort invites through the Gmail API when
`GMAIL_SENDER_ADDRESS` is set, and prints them otherwise. It needs one more
scope (`gmail.send`) on the refresh token and shares `SANDBOX_ALLOWLIST` — the
steps are in [email-setup.md](./email-setup.md). It has nothing to do with
calendar invitations, which are still created by `GoogleCalendarAdapter` with
`sendUpdates: "none"`.

Slack bot scopes, and no more: `chat:write` to post, `im:write` for the private
feedback DMs, `mpim:write` for the per-pair group DM, and — for the inbound
half — `im:history` and `mpim:history`, which are what let the bot *read* the
messages in the conversations it is already part of. Both history scopes are
required by the `message.im` / `message.mpim` event subscriptions and by
nothing else; without them the Events API delivers no message text and typed
notes never arrive. Skip `users:read` — the identity mapping is explicit and
verified by design (ADR-0006), so nothing needs to enumerate the directory.

### Creating the Slack app

1. Make the sandbox workspace first (step 1, above) — not the app.
2. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From an app manifest** → select the sandbox workspace → paste
   [`docs/slack-app-manifest.json`](./slack-app-manifest.json). It sets the
   three scopes above and nothing else.
3. Both `request_url`s in the manifest are placeholders. Interactivity can be
   left pointed at its one for now — Slack only re-verifies that URL when you
   save a change to it, so fix it once the tunnel (below) is actually up, from
   **Features → Interactivity & Shortcuts**. Event Subscriptions is different:
   Slack verifies its Request URL the moment you save it, so leave that one
   until the tunnel is up (below).
4. **Install App to Workspace**. Copy the **Bot User OAuth Token** (starts
   `xoxb-`) from **OAuth & Permissions**, and the **Signing Secret** from
   **Basic Information → App Credentials**.
5. Invite `dhavals+mentor@wekancode.com` and `dhavals+mentee@wekancode.com` to
   the sandbox workspace as members, and invite the bot into any channel or DM
   you test from.

### Creating the Google OAuth client

1. [console.cloud.google.com](https://console.cloud.google.com) → a fresh
   project → enable the **Google Calendar API** (APIs & Services → Library).
   For the running shared doc, also enable the **Google Drive API** and the
   **Google Docs API**.
2. **OAuth consent screen**: External, publishing status **Testing**. Add
   `dhavals@wekan.company` (and `dhavals@wekancode.com` if it needs to
   authorize too) under **Test users**. Testing mode is deliberate here — it
   caps the app at 100 users and nobody outside the test list can ever
   authorize it, which is the same shape of guarantee as the Slack sandbox
   workspace.
3. **Credentials → Create Credentials → OAuth client ID → Desktop app.**
4. Get a token without writing an OAuth callback server: the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) →
   gear icon → **Use your own OAuth credentials** → paste the client ID/secret
   → also in that gear-icon panel, set **Access type: Offline** and check
   **Force approval prompt** → scope `https://www.googleapis.com/auth/calendar`
   → **Authorize APIs**, signing in as the test account → **Exchange
   authorization code for tokens**.

   That exchange now returns both an access token and a **refresh token**.
   The access token alone expires in about an hour with no way back except
   redoing this whole exchange by hand — set `GOOGLE_CLIENT_ID` (the OAuth
   client's own id, not this token), `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_REFRESH_TOKEN` from this step instead, and
   `packages/integrations/src/google/auth.ts` mints fresh access tokens
   automatically from then on — `GOOGLE_ACCESS_TOKEN` can stay blank. One
   caveat: with the consent screen in **Testing** status (step 2), Google
   also expires a refresh token after 7 days of being unused for a refresh —
   this turns "update it every hour" into "every week," not "never." Move
   the consent screen to **In production** (still unverified — that only
   adds a one-time warning screen when authorizing) to remove that cap
   entirely, if a week is still too often for your test.

   To exercise the running doc too, authorize **three** scopes in that same
   exchange, not just the calendar one:
   `https://www.googleapis.com/auth/calendar`,
   `https://www.googleapis.com/auth/documents`,
   `https://www.googleapis.com/auth/drive.file`. Drive and Docs genuinely
   need more than Calendar does, and a calendar-only token fails on the first
   document write rather than at startup. `drive.file` rather than `drive`
   keeps the grant to files this app creates, which is the same
   least-privilege reasoning as using a dedicated secondary calendar.
5. On that account, create a **new, dedicated calendar** (not Primary) —
   Google Calendar → **Add calendar → Create new calendar**. Its Calendar ID
   is under that calendar's **Settings and sharing → Integrate calendar**.
   This is `GOOGLE_CALENDAR_ID`.
6. For the running doc: create a folder on that account for the test pairs and
   set `GOOGLE_DRIVE_FOLDER_ID` to its URL or id, and optionally a guideline
   doc for `GOOGLE_DRIVE_GUIDELINE_DOC_ID`. Both are also settable per org
   from the dashboard's **Shared document** page, which outranks the
   environment. Leave both unset and the `document` slot stays on the fake. A
   guideline doc is also what the proposal, reminder and feedback-request
   messages link back to — see "Google Drive (running doc)" in the README.
   The folder needs no manual sharing: each render explicitly grants both
   participants' emails writer access on the pair's doc, once, and skips
   anyone who already has it. Both addresses must therefore be real, *distinct*
   Google accounts, not a plus-addressed pair — see the note under "Isolate
   the workspace" above for why the sharing call rejects those outright.

## Reaching your laptop from Slack

Interactivity and the Events API both need a public HTTPS URL. One tunnel to
`pnpm serve:api` serves both — same host, two paths:

```bash
pnpm serve:api           # localhost:8787
ngrok http 8787          # brew install ngrok; needs a free account + authtoken
```

**Use ngrok, not `cloudflared tunnel --url`.** A `cloudflared` *quick* tunnel
(`trycloudflare.com`) looks fine from your own machine — `curl` against it
works, the tunnel process logs no errors — but Slack's own dispatcher does not
reliably deliver to it: a button click shows "Slack could not handle this
payload" and zero requests ever arrive at the tunnel, even with a correct
signing secret and a correctly-saved Request URL. This was confirmed the hard
way, across a fresh message, a fresh app, and a from-scratch tunnel restart,
before switching to ngrok fixed it immediately with no other change. ngrok
needs a one-time `ngrok config add-authtoken <token>` from a free
[dashboard.ngrok.com](https://dashboard.ngrok.com) account; the free plan's
URL changes every restart, so re-save both Slack Request URLs whenever you
restart the tunnel.

Point the app's Interactivity Request URL at
`https://<tunnel>/slack/interactions`, and, under **Features → Event
Subscriptions**, the Events Request URL at `https://<tunnel>/slack/events`.
Saving the second one makes Slack POST a one-off
`{"type":"url_verification","challenge":"…"}`; the endpoint answers it itself,
so the green **Verified** appears with nothing to do by hand — but note it is
answered *after* the signature check, so a wrong `SLACK_SIGNING_SECRET` shows
up here as a failed verification rather than later as silence. Then, under
**Subscribe to bot events**, add `message.im` and `message.mpim` and reinstall
the app when Slack asks.

Signature verification is already implemented and already tested on both
routes, and it is what makes exposing them acceptable: an unverified
interaction endpoint lets anyone book meetings for anyone, and an unverified
events endpoint lets anyone write whatever they like into a pair's session
record.

## Running it

Everything above is now wired, not just planned. `apps/worker/src/live-registry.ts`
builds a registry with real Slack (`SlackConversationAdapter`, and the new
`SlackDmAdapter` — there was no DM adapter until this doc needed one) and real
Google (`GoogleCalendarAdapter`, `sendUpdates: "none"`), every one of them
passed through `guardAdapter` before it is bound. Transcript and document stay
`FakeTranscript` / `FakeDocument`, because no real adapter for either exists —
this is the honest boundary of what a live run currently proves.

```bash
# 1. Fill in .env (copy .env.example), then export it into the shell, or
#    prefix each command — these examples do the latter.

# 2. One pair, seeded directly into Postgres — the same shape a roster
#    import produces, so the worker cannot tell the difference (ADR-0003).
#    Prints the ORG_ID to export for the next two commands.
DATABASE_URL=… MENTOR_SLACK_ID=U-… MENTEE_SLACK_ID=U-… \
MENTOR_EMAIL=dhavals+mentor@wekancode.com MENTEE_EMAIL=dhavals+mentee@wekancode.com \
pnpm seed:live-pair

export ORG_ID=<printed above>

# 3. The worker: real Slack + Google, guarded, polling.
DATABASE_URL=… ORG_ID=$ORG_ID SLACK_BOT_TOKEN=… GOOGLE_ACCESS_TOKEN=… \
GOOGLE_CALENDAR_ID=… SANDBOX_ALLOWLIST=dhavals+mentor@wekancode.com,dhavals+mentee@wekancode.com \
pnpm serve:worker:live

# 4. The endpoint, in another shell, behind the tunnel from "Reaching your
#    laptop from Slack" below.
DATABASE_URL=… ORG_ID=$ORG_ID SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=… pnpm serve:api

# 5. Only if you will use the dashboard (apps/web) against this org: make
#    yourself staff first. Nobody is staff by default (ADR-0010) — the seeded
#    mentor and mentee are participants, and a participant who signs in gets
#    "No admin access", not the dashboard. Use an address that is *not* one
#    of the pair's, or the mentor/mentee becomes an admin of the test org.
DATABASE_URL=… ORG_ID=$ORG_ID pnpm staff:grant --email you@example.com --role admin
```

`SLACK_BOT_TOKEN` is optional here and needed for exactly one thing:
"Suggest another" calls `views.open` from inside the click's own request,
because the `trigger_id` that authorises it expires in about three seconds —
far too soon to hand to the worker's relay. It needs no OAuth scope beyond
having interactivity enabled (`chat:write` already covers everything this app
sends), so the manifest is unchanged. Without the token the button acks and
logs `counter_modal_not_configured`, exactly as it did before the modal
existed.

The same token opens the **Session preferences** modal (ADR-0009), for the
same three-second reason; without it that button acks and logs
`preferences_modal_not_configured`. To check it live: press it on a proposal,
pick 30 minutes and "Every week", Save — the modal should replace itself with
"Saved: 30-minute sessions, every week", `pairings.cadence_override` should
show `{"sessionMinutes":30,"everyDays":7,"label":"weekly"}`, and the next
proposal should offer 30-minute slots. Try a custom length of `5` to see the
inline field error. No new scope or manifest change is needed.

The worker's next pass posts a proposal to a group DM with both Slack ids.
Click a time as one plus-addressed account, then the other — same as any
Slack user would, no curling required — and the saga should move to `armed`
with a real (unmailed) calendar event underneath it.

A recipient not on `SANDBOX_ALLOWLIST` never reaches Slack or Google at all:
`buildLiveRegistry` throws immediately if any of the four required variables
is missing, and every guarded call throws `SandboxRefusal` before the
transport is invoked. `apps/worker/src/__tests__/live-registry.test.ts` proves
both without a network call.

## Running more than one test org against the same database

Re-seeding for a fresh test (`pnpm seed:live-pair` without `ORG_ID` set, over
and over across a session) leaves every earlier org's data sitting in the same
local Postgres. That is normally harmless — but the worker's relay and timer
scan are **not** scoped to its own `ORG_ID`: they claim whatever is due across
every org in the database, then resolve it under the *current* process's
tenant. A leftover `pair.activated` event or a `saga_instances` row whose
timer you fast-forwarded in an earlier run, from an org this process was never
started for, hits `pairContext()` under the wrong org and throws
`unknown pairing <id>`.

The failure-recording write is itself org-scoped, so it silently updates zero
rows — the bad event never accumulates `attempts` or a `last_error` and is
never dead-lettered. It is simply reclaimed and re-thrown on the next pass,
and the one after that, indefinitely, ahead of whatever your current org
actually has pending. Watch for a repeating `[pass failed] unknown pairing …`
with no other progress — that is this, not a new bug in whatever you just
changed.

Until the relay/timer queries are scoped to `ORG_ID` (not done — see
CLAUDE.md's "what is real" table), the workaround is to silence the foreign
rows by hand:

```sql
-- events this process will never successfully relay
update events set relayed_at = now()
  where relayed_at is null and org_id != '<your ORG_ID>';

-- sagas whose timer is due, belonging to some other org
update saga_instances set timeout_at = now() + interval '30 days'
  where org_id != '<your ORG_ID>' and timeout_at <= now();
```

Neither touches state or version, only the scheduling columns, and neither is
destructive — it just stops those rows from being picked up.

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

## Capture what you see

A live run is the only time the adapters meet the real APIs, so keep the
evidence. Set `CAPTURE_VENDOR_FIXTURES=1` on `pnpm serve:worker:live` and every
Slack and Google request/response it makes is written, redacted, to
`tests/fixtures/vendor/` as `source: "live"` — replacing the hand-written
fixtures the adapter tests replay. Or run `pnpm test:contracts:live`, which
exercises every call in one pass with capture forced on. Review the diff before
committing it, and update the dates in
[vendor-contracts.md](./vendor-contracts.md).
