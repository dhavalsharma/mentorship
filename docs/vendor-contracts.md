# Vendor contracts

The Slack and Google adapters are tested against *replayed fixtures*, not
against Slack and Google. This file is the record of how far that can be
trusted: for every vendor call an adapter makes, when it was last seen to work
against the real API, and whether the fixture the tests replay was captured or
typed by hand.

It is tier 4 of [e2e-testing-strategy.md](./e2e-testing-strategy.md). Read
[live-tenant-testing.md](./live-tenant-testing.md) before running anything
below against a real account.

---

## How it fits together

| Piece | Where | What it does |
| --- | --- | --- |
| Fixtures | `tests/fixtures/vendor/<vendor>/<call>[--variant].json` | One request/response (or error) per vendor call, with `capturedOn` and `source: "live" \| "hand-written"`. Request paths are route templates (`/files/{fileId}/revisions`), never ids. |
| Recording transport | `packages/integrations/src/contracts/recording-transport.ts` | Wraps `httpSlackTransport` / `httpGoogleTransport` / `httpGoogleDocsTransport` / `httpGoogleSheetsTransport`, writes each pair it carries, redacted (`redact.ts`: tokens, secrets, emails, Slack user/bot/team/enterprise ids — whole values and embedded in text, e.g. `<@U…>` mentions in echoed `text`/`blocks`, ids in URLs, credential query parameters, webhook paths; channel ids kept). Re-redacting a fixture is a no-op, and a test holds every committed fixture to that. Best-effort: a failed write warns and never fails the live call. |
| Replay transport | `packages/integrations/src/contracts/replay-transport.ts` | Serves fixtures to the adapter tests. Throws `ContractDriftError` if an adapter sends a query or body field no fixture recorded, or a stateful test handler returns a response field the fixture does not have; throws `MissingFixtureError` for a call with no fixture. |
| Capture switch | `apps/worker/src/live-registry.ts` | `CAPTURE_VENDOR_FIXTURES=1` wraps every live transport in the recorder (`VENDOR_FIXTURE_DIR` overrides the destination). **Off by default.** The recorder sits *under* `SandboxGuard`, so a refused recipient is never recorded because it is never sent. |
| Live contract suite | `tests/contracts/live/vendors.contract.ts`, `pnpm test:contracts:live` | Drives every call below through `buildLiveRegistry` with capture forced on. Refuses to start (preflight, then again at import) without credentials **and** a `SANDBOX_ALLOWLIST` naming two Slack members and an email. Never collected by `pnpm test`. |
| Staleness warnings | `packages/integrations/src/__tests__/vendor-replay.ts` | Every replaying test file names, after it runs, each fixture it was served that is hand-written or older than `VENDOR_FIXTURE_MAX_AGE_DAYS` (default 90). A warning, never a failure. |

Tests replaying fixtures: `google-sheet.test.ts`, `google-document.test.ts`
(including `isEchoRevision`/`revisions.list`), `slack-dm.test.ts`,
`slack-conversation.test.ts`, `google-calendar.test.ts`, and
`vendor-contracts.test.ts` for the machinery itself (every fixture routes to
its own call, every known Google route has a fixture, redaction, drift).

---

## Sign-off table

Seeded on 2026-09-23 from the status table in `CLAUDE.md`. **Every fixture is
`hand-written`** — no live capture has been possible yet — so the right-hand
column is the same for every row today. "Verified live — date unknown" means
the call is named as having worked in a live sandbox run, but nobody recorded
when and nothing was captured. "Not recorded" means it must have run during a
live session (it precedes a call that did) but was never named as checked.

### Slack

| Call | Used by | Last verified live | Fixture |
| --- | --- | --- | --- |
| `auth.test` | `probe()` on both Slack adapters | not recorded | hand-written |
| `conversations.open` (group DM) | `SlackConversationAdapter.ensureThread` | verified live — date unknown | hand-written |
| `chat.postMessage` — plain | `postMessage` (reminders, pick status, booked) | verified live — date unknown | hand-written |
| `chat.postMessage` — plain, to a user id | `SlackDmAdapter.send` | not recorded (the adapter is named in the live run; which of its calls were checked is not) | hand-written (same fixture as above) |
| `chat.postMessage` — `agreement_proposed` | `postProposal` | verified live — date unknown | hand-written |
| `chat.postMessage` — `extraction_pending` (Confirm/Edit) | `postConfirmation` | **never** | hand-written |
| `views.open` — counter modal | `SlackWebApiModalOpener.openCounterModal` | verified live — date unknown | hand-written |
| `views.open` — preferences modal | `openPreferencesModal` (ADR-0009) | **never** | hand-written (shares the `views.open` fixture) |
| `im:history` / `mpim:history` scopes | inbound notes | **never** | `conversations.history` hand-written; the live suite reads back both a group DM and a 1:1 DM to prove them |
| `message.im` / `message.mpim` event subscriptions | `POST /slack/events` | **never** | none — see below |

### Google Calendar

| Call | Used by | Last verified live | Fixture |
| --- | --- | --- | --- |
| `calendarList.list` | `probe()` | not recorded | hand-written |
| `freebusy.query` | `freeBusy` | not recorded | hand-written |
| `events.insert` (`sendUpdates: "none"`, idempotency-keyed id) | `createEvent` | verified live — date unknown | hand-written |
| `events.insert` retried under the same id | effect retry (invariant 6) | **never** — the adapter's comment says it is a no-op; the live suite records what Google actually does | none |
| `events.get` | `getEvent` (the calendar-verify path) | verified live — date unknown | hand-written |

### Google Drive + Docs (`GoogleDriveDocumentAdapter`)

| Call | Used by | Last verified live | Fixture |
| --- | --- | --- | --- |
| `files.get` (folder probe) | `probe()` | not recorded | hand-written |
| `files.list` (adopt by name) | `createDoc` | not recorded | hand-written |
| `files.copy` | create-from-guideline | verified live — date unknown | hand-written |
| `documents.create` | blank-doc path | **never** (live runs used a guideline) | hand-written |
| `files.get?fields=parents` + `files.update` (move into folder) | blank-doc path | **never** | hand-written |
| `documents.get` | managed-region read | verified live — date unknown | hand-written |
| `documents.batchUpdate` | managed-region write | verified live — date unknown | hand-written |
| `permissions.list` | `grantEditAccess` | not recorded | hand-written |
| `permissions.create` — distinct account | `grantEditAccess` | verified live by `curl` — date unknown | hand-written |
| `permissions.create` — plus-addressed | `grantEditAccess` | observed live: `400 invalidSharingRequest` — date unknown | hand-written (`--error-plus-addressed`), body reconstructed |
| `revisions.list` → `lastModifyingUser.me` | `isEchoRevision` (ADR-0005 echo suppression) | **never** | hand-written — the single most important one to capture |

### Google Sheets (`GoogleSheetsAdapter`) — top of the list

| Call | Used by | Last verified live | Fixture |
| --- | --- | --- | --- |
| `files.get` (folder probe) | `probe()` | **never** | hand-written (shared with Drive) |
| `files.list` (adopt by name) | `ensureSpreadsheet` | **never** | hand-written (shared with Drive) |
| `spreadsheets.create` | `ensureSpreadsheet` | **never** | hand-written |
| `files.get?fields=parents` + `files.update` | move into folder | **never** | hand-written (shared with Drive) |
| `spreadsheets.get` | `writeTab` | **never** | hand-written |
| `spreadsheets.batchUpdate` (`addSheet`) | `writeTab` | **never** | hand-written |
| `spreadsheets.values.clear` | `writeTab` | **never** | hand-written |
| `spreadsheets.values.update` | `writeTab` | **never** | hand-written |

When a row changes, change it here in the same commit as the captured fixture:
the date, and `live` in the fixture column.

---

## Running the live suite

```bash
# .env or the shell — see live-tenant-testing.md for how to get each
SLACK_BOT_TOKEN=xoxb-…
SANDBOX_ALLOWLIST=U…,U…,someone@example.com   # two Slack members + one bare email
GOOGLE_CALENDAR_ID=…                           # the dedicated sandbox calendar
GOOGLE_DRIVE_FOLDER_ID=…                       # sandbox folder (docs; sheets too unless below)
GOOGLE_SHEETS_FOLDER_ID=…                      # optional
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=…   # or GOOGLE_ACCESS_TOKEN

pnpm test:contracts:live
git diff tests/fixtures/vendor   # review: redaction is automatic, not infallible
```

It leaves behind, in the sandbox only: a few bot messages in one group DM and
one 1:1 DM, one unmailed event in 2030 on the dedicated calendar, one doc and
one spreadsheet in the folder. It deletes nothing. Every person-addressing
call goes through `SandboxGuard`; the three raw transport calls that observe
facts no adapter method exposes (`conversations.history` ×2,
`revisions.list`, `spreadsheets.get`) address a thread or file the guarded
calls just created, and the one that could reach a person
(`conversations.open` for a 1:1) is checked against the same allowlist first.

A share is only offered to a bare (non-plus-addressed) allowlisted email,
because Drive refuses plus-addressed aliases.

**This has never been run.** It was written without credentials; only its
refusal path has been executed.

---

## What this cannot prove

- **Inbound events.** Whether Slack *delivers* `message.im` / `message.mpim`
  to `POST /slack/events` can only be seen by a human typing in the pair's
  thread with `apps/api` reachable (live-tenant-testing.md, "Reaching your
  laptop from Slack"). The suite proves the history scopes outbound; the
  subscriptions stay "never" until someone does that by hand and dates it here.
- **Anything after the capture date.** A fixture captured in March does not
  know about an API change in June — which is what the age warning is for.
- **A provider that never answers.** Not a vendor-fixture question, but the
  same shape: `runPrimitive` has no deadline of its own and relies on the
  model provider's (the Anthropic SDK's default is minutes). Refusal, a
  timeout *error* and a twice-invalid reply all reach `fallback`
  (`packages/primitives/session-intel/src/__tests__/hostile-provider.test.ts`);
  a promise that never settles would hang the extraction.

## Findings recorded by the fixtures, not yet acted on

- **A plus-addressed collaborator aborts the whole render.** `grantEditAccess`
  runs before the managed-region write, and its local email check accepts
  `name+tag@domain`, so Drive's `400 invalidSharingRequest` rejects
  `renderManagedRegion` and the session notes are never written — and the
  retried effect will fail the same way every time. Pinned as current
  behaviour in `google-document.test.ts` ("surfaces Drive's recorded refusal
  …"), not endorsed.
- **`documents.get` starts with a `sectionBreak`.** Every real Docs body does;
  the hand-written stub the tests used before never modelled it. The adapter
  handles it (`collectTextRuns` skips non-paragraph elements), and the replay
  now proves that rather than assuming it.
- **A new spreadsheet arrives with a `Sheet1` tab.** Harmless to the adapter
  (it adds tabs by name), but a report spreadsheet will carry an empty
  `Sheet1` forever unless something removes it.
