# Context for coding agents

Read this before changing anything. It carries the design reasoning that is not
visible from the code alone — particularly the **invariants**, which are the
things that look like arbitrary style until you break one and a pair gets two
calendar invites.

The decision records in `docs/decisions/` have the full argument for each
choice, including the options that were rejected and why.

---

## What this is

A multi-tenant kernel for running mentor–mentee programs. Four AI primitives
(matching, nudging, session intelligence, progress & risk) as swappable
contracts. Durable sagas for the flows that span days and wait on two humans.
Every external tool bound through a configured integration profile.

It is built to be forked: another team should be able to run a different
program, on different tooling, without touching `packages/core`.

```bash
pnpm install
pnpm test        # 689 tests, ~3s, no database and no model
pnpm demo        # the full session cycle printed as a trace
pnpm serve:api   # the Slack + auth endpoints, live, seeded against testkit
pnpm dev:web     # the admin dashboard at :3000, proxying to apps/api at :8787
pnpm typecheck

# the database-backed tests — 87 more, skipped above rather than failing
docker compose up -d db && pnpm db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mentorship pnpm test

# the Postgres path, running: DATABASE_URL + ORG_ID for both
pnpm serve:worker   # drains the outbox, fires due timers — fake adapters
pnpm serve:api      # the Slack endpoint, on Postgres when DATABASE_URL is set

# real Slack + Google, guarded — docs/live-tenant-testing.md before running any of this
pnpm seed:live-pair    # one pair, straight into Postgres
pnpm serve:worker:live # same loop, real adapters wrapped in SandboxGuard
```

`pnpm demo` is the fastest way to understand the system. It imports a roster,
drives one pair through propose → agree → book → remind → transcribe → extract
→ confirm → feedback → loop, and then runs the same saga against a tenant with
no transcription to show the degraded path.

---

## The one idea everything follows from

Most "generic" mentorship platforms stop being generic within a month, and it
is always the same mistake: **program policy gets compiled into the schema and
the code paths.** Someone hardcodes that a mentee has one mentor, that sessions
are fortnightly, that a goal has a due date. The next organisation runs group
mentoring on a six-week sprint, and the fork begins.

So there are five layers, and the boundaries between them are the design:

| Layer | Package | Changes |
| --- | --- | --- |
| **Kernel** | `core`, `db`, `events` | Rarely. It is the load-bearing wall. |
| **Orchestration** | `workflows` | Per release. Sagas — the things people call "agents". |
| **Primitives** | `ai`, `primitives/*` | Per release. The inference steps sagas call. |
| **Program policy** | data, in `programs.policy` | Per tenant, **at runtime**. Not code. |
| **Surfaces** | `integrations/*`, `apps/*` | Constantly. One adapter per destination. |

The connective tissue is an append-only **domain event log**. Primitives and
sagas never sit in a request path; they subscribe. That buys three things at
once: every step is independently testable, a slow or failed model call cannot
break a page load, and every automated action leaves a durable
before-and-after record.

---

## Invariants

Breaking one of these is a bug even if the tests pass. Most have a test; the
ones that do not are marked.

### Boundaries

1. **`packages/core` has zero infrastructure dependencies.** No db, no HTTP, no
   model client. Everything imports core; core imports nothing but `zod` and
   node builtins. If you need a type in two packages, it goes in core.
2. **Dependency direction is one-way:**
   `integrations → core` · `workflows → core, integrations` · `db` only from
   `api`/`jobs`/`workflows`. A saga must never import `db`; it reads through
   `SagaResolvers`. **Enforced by `pnpm deps:check`** (`.dependency-cruiser.cjs`)
   — not yet wired into CI, since no CI workflow exists in this repo yet.

### Tenancy

3. **Every tenant table carries `org_id`**, and every read or write runs inside
   `withTenant(db, orgId, …)`. The RLS policy reads `app.current_org`, so a
   forgotten `WHERE` returns zero rows rather than another org's data. There is
   no other door into the database.

### Sagas

4. **Sagas read through resolvers and mutate only through effects.** Never call
   an adapter from inside `step()`. Reads are deterministic and need no
   idempotency; writes are descriptors the engine executes with a key.
5. **Anything the saga needs back arrives as an event, never as a return
   value.** `create_calendar_event` does not return an id — the runner emits
   `session.scheduled` carrying it, and the saga waits for that. This is what
   makes every effect safely retryable, and it is why the `scheduling` state
   exists rather than jumping straight to `armed`.
6. **Effects are idempotent by key** (`saga:{id}:{step}:{index}`). The engine
   keeps a completed-effect ledger *and* passes the key to the adapter — belt
   and braces, because a retried step that posts a duplicate message is
   annoying and one that books a second invite ends a pilot.
7. **Every state carries an explicit timeout.** A saga with no `waitFor` and no
   `timeoutAt` and no `done` is stuck forever and nothing will tell you.
8. **Only two states may be model-driven** — `proposing` (drafts the message,
   picks which slots to offer) and `extracting`. Everything else is a
   deterministic transition. This is why the whole flow tests in milliseconds,
   and it is worth defending.

### Consent and agreement

9. **Never infer agreement or consent from prose.** `agreements` is a real
   table with a deterministic resolver and five outcomes. An inferred "I think
   they agreed", parsed out of free text, will eventually book a meeting nobody
   consented to. Buttons, or a structured reply, or nothing.
10. **Negotiation is capped** — two rounds, then a human. Uncapped
    counter-proposals are how a helpful bot becomes a muted one.
11. **Renudge once, then escalate.** Never a third attempt at the same silence.
12. **Recording consent is separate from AI-processing consent**, off by
    default, required from every party, and revoking it changes *future
    invites* — not just what gets extracted.

### Privacy

13. **A private message never falls back to the joint thread.** Every other
    degradation is fine; this one is not. A feedback request that lands in
    front of the other participant is worse than one that is not sent. See
    `dm` in `createEffectRunner`.
14. **Individual feedback scores are never attributed to a named person
    outside the pair**, at any level of the org chart, for any reason. Activity
    is attributable; sentiment is not. Enforced by `authorize()` in
    `packages/core/src/authorization.ts` — `feedback.sentiment` and a
    participant-attributed `signal` have no admin/program_lead branch at all,
    on purpose — and proved by
    `packages/core/src/__tests__/authorization.test.ts`.
15. **Notes are untrusted input.** A participant can paste anything into a
    note, including text shaped like instructions. Extracted content is never
    concatenated into a later prompt as instruction, and never authorises a
    tool call or a send.
16. **`safeguarding` bypasses everything** — no queue, no batching, no nudge.
    It reaches a named human out of band: the `extracting` saga state branches
    on the flag before rendering the shared doc or asking for confirmation
    (both would post into the pair's own thread), and instead runs
    `notify_safeguarding`, DMing `policy.safeguarding.contactMemberRef`. An
    unconfigured contact warns loudly rather than dropping the disclosure.
    This routing only *fires* on a detected flag — detection itself is a
    model call (invariant 8): `heuristicSessionIntel` and the primitive's own
    deterministic `fallback` both deliberately emit no risk flags, ever (see
    `packages/primitives/session-intel/src/fallback.ts`), because a
    cue-phrase regex cannot tell a disclosure from someone quoting one. A
    tenant running with no `llm` configured gets *no automated safeguarding
    detection*, only the ordinary human-confirmation step every extraction
    already goes through — not a substitute for detection, a floor under it.

### Model discipline

17. **The model never owns a number that affects a person.** Health scores are
    deterministic composites from `signals`; match scores come from feature
    vectors and a solver. The model explains, drafts and prioritises. "Why is
    this pair amber?" always has an answer.
18. **Every inferred output carries its evidence** — a span into the unedited
    source, so a claim can be checked rather than believed. Keep the spans when
    you replace `heuristicSessionIntel`.
19. **Extractions land `pending`.** A human confirms with one tap. That
    confirmation is both the UX and the eval label. A timeout auto-confirms but
    **marks it unverified** — never silently promote a machine guess to agreed
    fact.
20. **Write `ai_runs` before the first real model call**, with the prompt
    version stamped. Prompts live in a registry as versioned files, not inline
    in code. Retrofitting this means you can never answer "did v4 help?".

### Time

21. **Availability is UTC instants, never wall-clock strings.** "Tuesday 3pm"
    produces silently wrong overlaps across timezones and DST that look like
    matching bugs for months.

---

## Where to add what

| You want to… | Do this |
| --- | --- |
| Change what a program allows (roles, cadence, goal shape, weights) | Extend `ProgramPolicySchema` in `core/policy.ts`. It is data — no code path should branch on a tenant name. |
| Add a new external tool (Teams, Notion, Zoom) | Implement the slot port in `core/capabilities.ts`, put it in `integrations/<vendor>/`, declare its `AdapterCapabilities`. Nothing else changes. |
| Change what happens in a session | Edit `workflows/session-lifecycle.ts`. Add a state to the union, handle it in the switch, give it a timeout. |
| Add a whole new flow | New saga in `workflows/`, register it, add a `starters` entry for the event that begins it. |
| Add an AI capability | New package under `primitives/`, implement the `Primitive` shape (`resolve → infer → gate → fallback`). Call it from a saga via a `run_*` effect. |
| Add a domain event | Add the name to `EVENT_NAMES` in `core/events.ts`. Events are immutable and versioned. |
| Record something measurable | Write a row to `signals`. Do not add a bespoke table and a bespoke query; health, risk and dashboards all read from `signals`. |
| Handle a tenant that lacks a capability | Degrade in `createEffectRunner`, not in the saga — **unless** the missing capability changes the *flow* (e.g. no transcription means never polling), which is a saga branch. |
| Add a report type to the sheet-sync job | New `ReportSource` in `apps/worker/src/reports.ts` (a query inside `withTenant`, shaped into primitive-valued rows — mirror `riskFindingsReport`/`nudgesReport`), registered in that file's `REPORT_SOURCES` map. Nothing else in the sync path changes. |

---

## Conventions

- **Zod schema first, type inferred.** `z.infer<typeof XSchema>`, not a
  hand-written interface alongside.
- **Branded ids** (`core/ids.ts`). Free at runtime, and they stop the most
  common bug in a system with this many foreign keys.
- **State machines are discriminated unions on `name`.** `stateName()` reads it
  for history and traces.
- **`import type`** for type-only imports; `isolatedModules` is on.
- **No default exports.** Named exports only, re-exported from each package's
  `index.ts`.
- **Tests are colocated** in `src/__tests__/*.test.ts` and run through the
  `@mentorship/*` aliases, not relative paths.
- **Comments explain *why*.** The code already says what. A comment that
  restates the line above it is noise; one that records a rejected alternative
  is the most valuable thing in the file.

---

## Things that look like bugs and are not

- **`Dispatcher` queues events instead of delivering them synchronously.**
  Effects emit events, and those events advance sagas — delivering inline would
  re-enter the engine mid-transition and corrupt the version check. In
  production this is the outbox relay, for the same reason.
- **The engine swallows `SagaConflictError`** and returns the stored row.
  Another writer won the race; the effect ledger means the winner's retry skips
  what already ran.
- **`heuristicSessionIntel` is deliberately dumb.** Cue-phrase matching, no
  model. It exists so the document projection, the confirm step and the tests
  are exercised end to end in milliseconds. The seam is the `SessionIntel`
  interface — swap the implementation, keep the evidence spans.
- **`proposeSlots` returns `[]` rather than a bad slot.** India and California
  both keeping 09:00–18:00 locally have no mutual working hour. Saying so beats
  proposing 03:00, and the saga escalates to a human.
- **`tzOffsetMinutes` is a fixed offset, not an IANA zone.** A known
  simplification, flagged in `core/time.ts`. Correct for a scaffold and wrong
  twice a year.
- **`FakeCalendar` dedupes on `idempotencyKey`.** Not test convenience — it
  mirrors what the real Google adapter does by using the key as the event id.

---

## What is real and what is not

Keep this table honest as you go; it is the first thing a contributor reads.

| Piece | State |
| --- | --- |
| Core contracts, policy schema, agreement resolver, interval maths | Working, tested |
| Saga engine — idempotent effects, optimistic concurrency, timers, history | Working, tested |
| `SessionLifecycle` — all deterministic states | Working, tested. A pick now shows up in the thread: one participant accepting posts "X picked <slot>. Waiting on Y." instead of the silence there used to be, and a conflict (both accepted, different slots) says who picked what before re-offering. |
| Roster import — parse, plan, validate, commit | Working, tested |
| Integration registry, capability negotiation, degradation | Working, tested |
| Fake adapters | Working — used by tests and the demo |
| Postgres schema, RLS, `withTenant` | Working, tested. Migrations applied; the cross-tenant leak test proves the policy bites (`packages/db/src/__tests__/rls.test.ts`). |
| Outbox relay (`relayOnce` / `relayLoop`) | Working, tested — claim with `SKIP LOCKED`, at-least-once, backoff and dead-lettering. The admin-facing gap ROADMAP phase 1 named ("saga instances not advanced in N days; dead-letter review") is now closed: `listStuckSagaInstances`/`listDeadLetteredEvents` (`packages/workflows/src/postgres-reads.ts`, org-scoped, run inside `withTenant`) back `GET /orgs/:orgId/{stuck-sagas,dead-letters}` on `apps/api` — same `authenticateAdmin` 401/403 gating as risk-findings/nudges, `stuck-sagas` taking an optional `?days=` (default 3) — rendered by `apps/web`'s `/dashboard/{stuck-sagas,dead-letters}` pages. Read-only: no acknowledge/replay action yet, same as risk-findings. |
| `PostgresSagaResolvers`, `PostgresEventSink`, `PostgresProjector` | Working, tested — the counterparts to testkit's `World`, including the projections that make read models appear. |
| `createWorker` + `pnpm serve:worker` | Working, tested end to end and run by hand: a `pair.activated` row becomes a proposed, agreed and booked session on Postgres, driven by two real signed Slack clicks. Bound to the fake adapters, because Slack and Google have still never run live. The loop now has a third kind of tick alongside relay-drain and timer-fire: `worker.sweep()` (`apps/worker/src/scheduler.ts`'s `Scheduler`), called every iteration, runs the nudge, progress and digest sweeps each on its own configurable interval (`NUDGE_SWEEP_INTERVAL_MS`/`PROGRESS_SWEEP_INTERVAL_MS`/`DIGEST_INTERVAL_MS`), org-scoped, with an overlap guard so a slow sweep is never started twice and a failure backs off a full interval rather than retrying every tick. See the Nudge/Progress rows below for what each sweep actually does. |
| `PostgresSagaStore` | Working, tested — round-trip, optimistic concurrency under a real race, and parity with `MemorySagaStore`. Imported from `@mentorship/workflows/postgres` so the default entry stays driver-free. |
| Slack interaction endpoint, mounted behind `apps/api` (`node:http`) | Working, tested over a real socket with a genuine HMAC signature and against the actual saga. Runs on Postgres when DATABASE_URL is set (verified identity links, response and outbox event in one transaction) or on the in-memory world without one. **No relay drains the outbox yet**, so on Postgres the click is recorded and the saga does not move. "Suggest another" now opens a real modal: the click calls `views.open` **synchronously, inside its own request** (`SlackWebApiModalOpener`, `packages/integrations/src/slack/modal.ts`), because the `trigger_id` expires in about three seconds — an effect run later by the relay would open nothing. The modal is a `datepicker` + `timepicker`, so a counter-proposal stays a structured fact and is never parsed out of prose (invariant 9); its `private_metadata` carries the agreement id. The `view_submission` that comes back arrives at the same route and is signature-verified the same way before anything else looks at it, then becomes a real `AgreementResponse.counter` — the first caller ever to populate a field core has always had — which `resolveAgreement` reads as `countered`, making the saga's (already correct, untouched) re-propose-and-cap path reachable. Bad input answers with Slack's `response_action: "errors"` against the offending block rather than failing silently. **Run against an actual workspace** (a sandbox one, `docs/live-tenant-testing.md`): propose → accept/counter → book, and "Suggest another" end to end — a real modal, a real UTC-converted counter, a real new round. That run also found a real bug, since fixed: `PostgresProjector.agreementOpened()` derived `pairing_id` from the event's subject ref, which for this one event is `agreement:<id>` (the `emit` effect re-subjects anything carrying an `agreementId`) rather than `pairing:<id>` — every agreement's `pairing_id` came out equal to its own `id`. Invisible until the counter modal's context lookup was the first thing to join *from* an agreement back to its pairing. Fixed by reading `pairingId` from the payload, which had always carried the correct value. |
| Slack Events listener (notes capture) + Confirm/Edit buttons | `POST /slack/events` on `apps/api`, and `ConversationAdapter.postConfirmation`. Working, tested — same raw-body signature discipline as the interaction route, the `url_verification` handshake answered only *after* that check, bot messages and message subtypes ignored, the Slack `ts` carried as `noteId` so a retry is a no-op (proven against Postgres), and a message from someone who is not a party to the pair refused rather than recorded as their notes. The verdict on an extraction now comes off **Confirm**/**Edit** buttons (`confirm_extraction:<id>` / `edit_extraction:<id>`) through the same "write the fact, 200, let the relay advance the saga" path as an agreement click — prose is never read as a verdict (invariant 9), and a typed "confirmed" in the thread is only ever a note. A message is attributed to a pair by channel id, which reaches `pairings.thread_ref` via the new `pair.thread_bound` event and its projection; without a bound thread the message is acked and dropped. **Never run against an actual workspace** — the scopes (`im:history`, `mpim:history`) and subscriptions (`message.im`, `message.mpim`) are declared in `docs/slack-app-manifest.json` and unexercised, and on Postgres the relay gap above applies here too: the note is recorded and the saga does not move until a relay drains it. |
| `SlackConversationAdapter`, `SlackDmAdapter`, `GoogleCalendarAdapter` | API shapes real; wired into `pnpm serve:worker:live` through `SandboxGuard`, which throws before any disallowed recipient reaches the transport (`live-registry.test.ts`, no network). **Run against an actual sandbox workspace and a real Google Calendar**: `conversations.open` on a real multi-party DM, `chat.postMessage` for proposals/reminders/pick-status/booked confirmations, `events.insert` with an idempotency-keyed id creating a real (unmailed, `sendUpdates: "none"`) invite, a reminder firing on the real calendar-verify path. Running this by hand against a shared local Postgres also surfaced an operational gap: the worker's timer scan was not scoped to its own `ORG_ID` — a due `saga_instances` row left over from a *different* org (e.g. an earlier live-tenant run against the same database) got claimed anyway, `pairContext()` threw `unknown pairing` under the wrong tenant, and since `SagaEngine.tick()` has no per-instance failure handling the whole pass aborted, ahead of anything that pass could otherwise deliver — reclaimed and re-thrown forever. **Fixed**: `SagaStore.findDue(now, orgId?)` now takes an optional org filter (both `MemorySagaStore` and `PostgresSagaStore`, `packages/workflows/src/store.ts` / `postgres-store.ts`), `SagaEngine.tick(orgId?)` threads it through, and `createWorker`'s `pass()` calls `engine.tick(options.orgId)` (`apps/worker/src/worker.ts`) — covered by a store-level test and an engine-level test, both asserting a same-tick foreign-org instance is left untouched. The relay's own claim query (`relayOnce` in `packages/workflows/src/relay.ts`) was already `orgId`-scoped and `createWorker` already passed its `orgId` there, so that half of the original note no longer applied by the time this was checked — only the timer scan needed the fix. Google auth no longer needs a manually re-pasted access token every hour: `GoogleAccessTokenSource` (`packages/integrations/src/google/auth.ts`) is a thunk both Google transports call per-request rather than a string closed over at boot, and `refreshableGoogleAccessToken` mints fresh access tokens from a refresh token automatically. `live-registry.ts` prefers `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` when all three are set, falling back to a static `GOOGLE_ACCESS_TOKEN` otherwise. |
| `GoogleDriveDocumentAdapter` (the running shared doc) | `packages/integrations/src/google/document.ts`. API shapes real, managed-region logic tested against a stubbed transport — create-from-guideline (Drive `files.copy`) vs blank-create-then-move, marker seeding, and replace-in-place that provably leaves everything outside the markers byte-identical (ADR-0005). Vendor config (`folderId`, `guidelineDocId`) lives on the new `integration_bindings.config` jsonb (migration `0010`), resolved at worker boot by `resolveDocumentConfig` — a DB row beats `GOOGLE_DRIVE_FOLDER_ID`/`GOOGLE_DRIVE_GUIDELINE_DOC_ID`, and the two are never merged. The doc's name comes from `policy.document.namingTemplate`, whose default renders exactly the string the saga used to hardcode. A configured `guidelineDocId` doubles as the org's playbook link: `PairContext.playbookUrl` carries it (null when unconfigured) and the proposal, the *shared* reminder and the private feedback request append one line each — the individual heads-up DMs deliberately do not, and an unconfigured org's message text is byte-identical to before, with a regression test pinning the literals. Access is granted, not assumed: `renderManagedRegion` takes `collaborators: { email }[]` on the *port* (vendor-agnostic — core never learns the word "writer") and the Drive adapter turns that into `permissions.create` with `role: "writer"`, after a `permissions.list` so a re-render neither piles up duplicate permission objects nor re-sends Drive's access-granted email; an unusable address is warned about and skipped rather than failing the whole render — but "unusable" is only ever a local, syntactic check (`EMAIL.test`), and a plus-addressed email passes it. Without this a copied doc is unreachable — Drive does not carry the guideline doc's sharing onto the copy. Not wrapped in `SandboxGuard` — it addresses a folder, not a person; the grant does address a person, but only ever the pair's own two emails, which the saga already messages. **Run against an actual Drive/Docs account** (`docs/live-tenant-testing.md`): create-from-guideline, managed-region write and the doc's URL all worked first try. `grantEditAccess` did not, against the sandbox's plus-addressed test emails specifically — Drive's `permissions.create` answers a genuinely distinct account, but returns `400 invalidSharingRequest` for `name+role@domain`, confirmed directly with `curl` (the bare address succeeds, the plus-addressed one does not). Not a bug here — the adapter calls the API correctly and Google's own service is the one refusing the address — but it means the plus-addressing this doc recommends for a two-person Slack test cannot double as the two Drive-sharing recipients; see the note under "Isolate the workspace" in that doc. Both ADR-0005 safeguards flagged as outstanding above are now built, closing the gap between them and this adapter's real writes: `resolveManagedRegionWrite` (`packages/core/src/document-projection.ts`) is the vendor-agnostic comparison — given the markdown we're about to render, the region's current content, what we last rendered ourselves, and an `isEcho` flag, it decides whether to render normally, render anyway (an echo of our own write, never a human edit), or preserve a genuine human edit untouched and report `pinned: true` on `DocumentAdapter.renderManagedRegion`'s result (a field the port interface now carries). `GoogleDriveDocumentAdapter` supplies the one Drive-specific fact core cannot know — whether the current revision was authored by us — via `isEchoRevision`, reading `lastModifyingUser.me` off Drive's `revisions.list`; `FakeDocument` tracks the same distinction in-memory for tests, with `humanEdit`/`simulateServiceEcho` test hooks standing in for a real human edit and a real echo respectively. The baseline ("what we last rendered") is process-local, in-memory state on the adapter instance, the same documented limitation `FakeCalendar`'s idempotency map already has — a worker restart forgets it, which just means the next render treats the region as untouched rather than silently misbehaving. Tested in `packages/integrations/src/__tests__/fake-document.test.ts` and `packages/integrations/src/__tests__/google-document.test.ts` ("echo suppression and pinning" in both). **Not yet run against a real Drive account** — `isEchoRevision`'s reliance on `revisions.list` reporting `lastModifyingUser.me` is unverified outside the stub. |
| `Primitive` contract, `LlmProvider` port, `packages/ai` | Working, tested. `runPrimitive` never throws because the model failed — refusal, timeout or a schema violation surviving one repair all end at the primitive's `fallback`, with the run recorded either way. |
| Session intelligence | `packages/primitives/session-intel`. Working, tested — evidence spans, `safeguarding`-gates-to-`escalate`, deterministic fallback. Wired into `createWorker`/`bootstrap()`: pass `llm` (an `AnthropicProvider` in production, `ANTHROPIC_API_KEY`-gated; a `DeterministicProvider` in tests) and it replaces `heuristicSessionIntel` at the `extracting` state — omit it and the deterministic stub still runs, so nothing existing had to change. Pending-then-confirm is real: Slack's Confirm/Edit buttons write `extraction.confirmed`/`extraction.edited`, which now also becomes that extraction's `ai_runs.verdict` — `createPrimitiveSessionIntel` stamps a pre-generated extraction id onto the run as `subjectId` (migration `0012` adds the column), and `PostgresExtractionResponder` calls the new `AiRunSink.setVerdict` right after the domain event, best-effort so a label write can never fail the click. `safeguarding` is routed out of band: `effects.ts`'s `run_extraction` now surfaces the primitive's `gate`, and the `extracting` saga state branches on it before `render_document`/`request_confirmation` (which post into the pair's own thread) — a flagged extraction instead runs `notify_safeguarding`, DMing `policy.safeguarding.contactMemberRef` and emitting `safeguarding.flagged`; an unconfigured contact warns loudly rather than dropping the disclosure. |
| Matching | `packages/primitives/matching`. Working, tested — hard constraints, feature scorers (including `narrative_similarity`, cosine over embeddings a caller resolves up front with `embedNarratives` — live pgvector storage/query is not built, unverifiable in this sandbox), a capacity-aware min-cost-flow solver (beats greedy on coverage), and a bounded model adjudication pass on the shortlist only (invariant 17). `runMatchingRound`/`commitMatchingRound` (`round.ts`) turn assignments into pairings through the same sink shape `RosterSink` already uses (`World` satisfies it unchanged) — a matched pair produces the identical `pair.activated` an imported one does (ADR-0003), auto-committing only when policy has turned `requireAdminApproval` off. Not yet a saga and not yet callable from anywhere real: there is no cohort/enrolment data model yet to build a `MatchingPool` from (phase 0 gap), so this is exercised with hand-built fixtures, not a live cohort. The persisted candidate set now has a reader: `getMatchingRoundCandidates` (`apps/api/src/postgres-reads.ts`) pulls a round's full `MatchingOutput` back out of `ai_runs` by run id and marks each candidate `won` against `assignments`, behind `GET /orgs/:orgId/matching-rounds/:runId/candidates` (`authenticateAdmin`-gated) and rendered at `/dashboard/matching-rounds` — a run-id lookup, not a browsable list, since nothing yet indexes rounds by cohort. Constraint-satisfaction and coverage are also now a named, standalone suite rather than incidental coverage: `packages/primitives/matching/src/__tests__/invariants.test.ts` runs the same two properties `pipeline.test.ts` already asserted, but across 40 randomized seeded cohorts instead of hand-built fixtures, as part of the default `pnpm test` (there is still no CI workflow file in this repo for either to be wired into). |
| Nudge | `packages/primitives/nudge`. Working, tested — a deterministic temporal sweep turns absence into deficit events; every send passes a gate chain (mute/snooze, dedupe, privacy, already-booked, rate limit, quiet hours in the recipient's own zone) the model cannot override; a Thompson bandit picks templates. `runNudgeSweep` (`sweep.ts`) runs the planner per deficit, dispatches only on `gate === "auto"`, and records every outcome through `PostgresNudgeRecordSink` into the existing `nudges` table (an escalation, addressed to a human rather than a participant, is honestly skipped rather than forced into a `NOT NULL` column — the same gap invariant 16 already names for `safeguarding`). Now called by something real: `apps/worker`'s `Scheduler` ticks a nudge sweep on a configurable interval (`NUDGE_SWEEP_INTERVAL_MS`, default 15 minutes), org-scoped to the worker's own `ORG_ID`. `packages/primitives/nudge/src/postgres.ts` adds `PostgresNudgeReader` and `listCohortDeficitInputs` — real queries, but an honest MVP against the current schema: every recipient reads as unmuted and on the program-wide default quiet hours (no per-participant mute/snooze/quiet-hours columns exist yet), `history()` can only recover `sentDedupeKeys` (no `template_id`/`tone` column on `nudges` to reconstruct `delivered` from), and `templateStats()` is always `[]` (the bandit runs on a uniform prior rather than learning) for the same reason. `apps/worker/src/sweeps.ts` assembles the reader against a real `dm` adapter dispatch (`RegistryNudgeDispatchSink`, verified-chat-link-or-nothing, same rule as `pairContext`). |
| Progress & risk | `packages/primitives/progress`. Working, tested — health is a policy-weighted composite over present signals only (ADR-0007); risk is four named, evidence-carrying rules, not a classifier. `runProgressSweep` assesses a given list of pairings and writes every finding to a `RiskFindingsSink`; `PostgresRiskFindingsSink` (`./postgres`) persists to the new `risk_findings` table (migration `0006`/`0007`, RLS included). Now scheduled: `apps/worker`'s `Scheduler` ticks a progress sweep on a configurable interval (`PROGRESS_SWEEP_INTERVAL_MS`, default 15 minutes), one call per cohort (`listActivePairingsByCohort` in `./postgres`, since policy is per-cohort data and `runProgressSweep` takes one `policy` per call), org-scoped. `PostgresProgressReader` reads real `sessions`/`action_items`/`goals`/`goal_checkins` rows; `activity`, `surveys`, `responseLatencies` and `mentorPortfolio` stay honestly empty — nothing in the schema records them yet. There is now an admin view over `risk_findings` (`/dashboard/risk-findings`) but no acknowledgement workflow — it is a durable log surfaced read-only. A new scheduled digest (`apps/worker/src/digest.ts`, `DIGEST_INTERVAL_MS`, default hourly) reads this table plus `nudges` over a trailing window and persists a computed summary as a `digest.computed` event — there is no real notification channel yet, so today this means compute-and-persist, not send. |
| Authorization (visibility matrix) | `packages/core/src/authorization.ts` — pure, deterministic `authorize(actor, resource)`. No admin/program_lead branch on `feedback.sentiment` or a participant-attributed `signal` (invariant 14); `pairing.activity`/`risk-finding`/`nudge` visible to org-chart roles org-wide and to pair members for their own pairing; cross-org denied before any role check runs. Working, tested — `packages/core/src/__tests__/authorization.test.ts`, 26 cases including the invariant-14 one. Wired into `apps/api/src/server.ts`'s `handleAdminList`, gating `GET /orgs/:orgId/{risk-findings,nudges}` after `authenticateAdmin`. Not yet wired to anything pair-scoped — `apps/api` has no route that reads per-participant data and no session-to-pairing-membership resolution to build one on; that resolution is the next real exercise of this module, not a gap in the module itself. |
| Auth | `packages/auth` — magic-link only (SAML explicitly deferred: it needs a real external IdP this repo has no way to build or verify against, kept off the roadmap rather than half-built). Token/session logic against a `MagicLinkStore` port, `PostgresMagicLinkStore` backing it via `magic_links`/`auth_sessions` tables. Enumeration-safe by design; consuming a link is race-safe (an atomic `UPDATE ... WHERE consumed_at IS NULL`, not a check-then-write). Wired into real routes: `POST /auth/request-link` / `POST /auth/verify` on `apps/api`, which also now guard the admin read routes with a session + tenancy check (401/403) — previously unauthenticated. |
| Enrolment | `packages/enrollment` — `planInvite`/`commitInvite` (invite one person to a cohort+role, deduped) and `acceptInvite` (the identity-verification-at-enrolment item: records a verified identity link, flips a participant to `enrolled`). No schema change — built entirely on tables that already existed. First writer for the previously-unused `audit_log` table, via an optional `AuditSink`. Not wired into any HTTP route yet — nothing yet lets an admin actually send an invite. |
| Web app, dashboards | `apps/web` — Next.js App Router, Tailwind, shadcn/ui. The first frontend in this repo. `/login` + `/verify` drive `packages/auth`'s magic-link flow through real `apps/api` routes, preserving its enumeration-safety property on the client too (identical message on every outcome). `/dashboard/{risk-findings,nudges,stuck-sagas,dead-letters}` render the real tables, `/dashboard/matching-rounds` is a run-id lookup over a matching round's persisted candidates, `/dashboard/settings/document` writes the `document` slot's folder/guideline/naming-template through a PUT route gated by the same `authenticateAdmin` (401/403) the read routes use, and `/dashboard/settings/sheet` does the same for the `sheet` slot's folder/spreadsheet (see the sheet-sync row below). No `/auth/me` endpoint exists, so the dashboard layout answers "am I logged in" with a cheap probe request to a protected route. `/api/:path*` is proxied to `apps/api` (`next.config.ts`) so the browser only ever talks to one origin — no CORS configuration anywhere. |
| Program-progress → Google Sheets sync | New `sheet` slot: `SheetAdapter` port (`packages/core/src/capabilities.ts`, modeled on `DocumentAdapter`), `GoogleSheetsAdapter` (`packages/integrations/src/google/sheet.ts` — API shapes real, not run against a live Sheets account; create-then-move-into-folder via Drive, same two-step dance `GoogleDriveDocumentAdapter` uses, since Sheets' own `spreadsheets.create` cannot place a file in a folder) and `FakeSheet` (`packages/integrations/src/fakes.ts`) for tests/demo. Report types are a registry (`apps/worker/src/reports.ts`'s `REPORT_SOURCES` — `risk-findings` and `nudges` shipped, each a query inside `withTenant` shaped into primitive-valued rows by a pure, separately-tested function); adding a third is one new entry. `syncReports` creates the destination spreadsheet only when none is configured, then clears and rewrites each report type's tab in full on every sync — a deliberate full overwrite, never append/dedupe (append would need a stable row key every future report type can't promise, and an ever-growing sheet nothing prunes). No spreadsheet configured → the first sync creates one inside the org's Drive folder and persists the id back onto `integration_bindings` (slot `"sheet"`, the same upsert `PostgresDocumentSettingsStore.write` uses for `document`), so a second sync reuses it instead of creating a second spreadsheet — proven on Postgres (`apps/worker/src/__tests__/report-sync.test.ts`), including that it never reads a foreign org's rows. Scheduled exactly like the nudge/progress/digest sweeps: `Scheduler`/`worker.ts`'s `schedules.reportSync`, `REPORT_SYNC_INTERVAL_MS` (default hourly — a report tab is checked in on periodically, not something needing sub-minute freshness), org-scoped, off unless a `sheet` binding exists. `GET`/`PUT /orgs/:orgId/settings/sheet` (`apps/api`, `PostgresSheetSettingsStore`) and `apps/web`'s `/dashboard/settings/sheet` let an admin set the folder and, optionally, an existing spreadsheet — mirroring the `document` slot's settings pattern exactly. Bound in `apps/worker/src/live-registry.ts` alongside `GoogleDriveDocumentAdapter`, **not** wrapped in `SandboxGuard`, for the same reason that adapter is not: a report spreadsheet addresses a Drive folder, not a person. A `progress` report type (per-pairing health scores) was considered and deliberately left out — `computeHealth` (`packages/primitives/progress/src/health.ts`) is a pure function over `signals`, not a persisted, queryable row (ADR-0007: the model explains a score, nothing stores one for later reporting), and inventing a table to make it reportable would be the same "invent a fake email adapter" mistake `digest.ts`'s own comment warns against. |

The `testkit` package is an in-memory stand-in for `db` + `api`. Every method
has a direct Postgres equivalent: reads become queries inside `withTenant`,
projections become outbox-relay subscribers, and `SagaStore.save` becomes
`UPDATE … WHERE version = $expected`.

---

## Decision records

`docs/decisions/` — read the one that covers the area you are changing.

| ADR | Decision |
| --- | --- |
| [0001](docs/decisions/0001-program-policy-is-data.md) | Program policy is data, not code |
| [0002](docs/decisions/0002-agents-are-durable-sagas.md) | Long-running flows are durable sagas, not primitives |
| [0003](docs/decisions/0003-pairing-is-optional.md) | Pairing is an optional mode; import emits the same event as matching |
| [0004](docs/decisions/0004-agreement-is-deterministic.md) | Agreement resolution is deterministic, with five outcomes |
| [0005](docs/decisions/0005-document-is-a-projection.md) | The database is the source of truth; the shared doc is a projection |
| [0006](docs/decisions/0006-capabilities-are-probed.md) | Capabilities are probed per tenant, not inferred from the vendor |
| [0007](docs/decisions/0007-scores-are-deterministic.md) | Scores are deterministic; the model explains them |
| [0008](docs/decisions/0008-postgres-only.md) | Postgres only — pgvector, pg-boss, RLS |

`docs/ROADMAP.md` has the build order and why it is in that order.
