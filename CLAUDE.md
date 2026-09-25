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
pnpm test        # 777 tests, ~3s, no database and no model
pnpm demo        # the full session cycle printed as a trace
pnpm serve:api   # the Slack + auth endpoints, live, seeded against testkit
pnpm dev:web     # the admin dashboard at :3000, proxying to apps/api at :8787
pnpm test:browser # six Playwright journeys over apps/web — needs a migrated Postgres
pnpm typecheck

# the database-backed tests — 97 more, skipped above rather than failing
docker compose up -d db && pnpm db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mentorship pnpm test

# the journey suite (tests/e2e/) — apps/api + apps/worker on one Postgres, ~15s;
# fails, rather than skips, without DATABASE_URL
DATABASE_URL=... pnpm test:e2e          # every journey + properties P1, P3, P4, P5
DATABASE_URL=... pnpm test:e2e:nightly  # + P2 crash-resume, ~2 min

# the Postgres path, running: DATABASE_URL + ORG_ID for both
pnpm serve:worker   # drains the outbox, fires due timers — fake adapters
pnpm serve:api      # the Slack endpoint, on Postgres when DATABASE_URL is set

# real Slack + Google, guarded — docs/live-tenant-testing.md before running any of this
pnpm seed:live-pair    # one pair, straight into Postgres
pnpm serve:worker:live # same loop, real adapters wrapped in SandboxGuard

# never in `pnpm test` — docs/vendor-contracts.md, docs/e2e-testing-strategy.md tiers 4–5
pnpm test:contracts:live  # live Slack/Google contract suite + fixture capture; refuses without creds + SANDBOX_ALLOWLIST
pnpm eval                 # session-intel eval; deterministic fallback unless ANTHROPIC_API_KEY; exits 0 whatever the scores
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
   `SagaResolvers`. **Enforced by `pnpm deps:check`** (`.dependency-cruiser.cjs`),
   a step in `.github/workflows/ci.yml` — written, not yet run on GitHub.

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
   annoying and one that books a second invite ends a pilot. The ledger is
   saved with the step, so it cannot cover a crash mid-step; the key can, and
   that includes the event log: every event an effect emits carries
   `{key}:{event name}` and dedupes on `events_idempotency_key_unique`.
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
| Change what a *pair* may choose for itself (session length, rhythm) | Edit `policy.pairPreferences` (data). Validation is `resolvePairPreferences` in `core/pair-preferences.ts`; whatever a pair picks lands on `pairings.cadence_override`, the level `resolveCadence` merges last, so no reader needs to change. ADR-0009. |
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
| Saga engine — idempotent effects, optimistic concurrency, timers, history | Working, tested. `tick()` isolates failures per instance (was e2e bug #4): a timer step that throws is recorded on that instance's history (`error`, `attempt`, the effect ledger as far as it got, so a retry does not repeat what already ran), its `timeoutAt` backed off on the relay's 4ⁿ-second curve, and after `maxStepAttempts` (default 5) it is parked as `status: "failed"` and escalated best-effort — never aborting the tick for every other instance. `tick()` returns `{ fired, advanced, failed, parked }`, surfaced by `worker.pass()` and the `serve:worker` log line. Event-driven steps still fail into the relay's own retry/dead-letter; the relay now passes its attempt count through `deliver`. No migration — the attempt count is read back from history. |
| `SessionLifecycle` — all deterministic states | Working, tested. A pick now shows up in the thread: one participant accepting posts "X picked <slot>. Waiting on Y." instead of the silence there used to be, and a conflict (both accepted, different slots) says who picked what before re-offering. |
| Roster import — parse, plan, validate, commit | Working, tested. Reads an optional `duration` column (`session_minutes`/`session_length`/`meeting_length`/`meeting_duration`/`length`; "30", "45m", "1h") into the pair's `cadenceOverride.sessionMinutes`, bounded 15–240, and cadence written in weeks ("every 3 weeks", "4 weeks"). |
| Pair-chosen session length and rhythm (ADR-0009) | Working, tested — including against real Postgres (`apps/api/src/__tests__/postgres-pair-preferences.test.ts`). Every proposal carries a **Session preferences** button (when `policy.pairPreferences.enabled`, default on) that opens a Slack modal — synchronously in the click's request, like "Suggest another" — with the program's menu (default 15/30/45 minutes and every 1/2/3/4 weeks, each with a "custom" number field). Validated in core against the program's own menu, not just schema bounds (`resolvePairPreferences`); either pair member may change it; a stranger is refused at click *and* submission. `PostgresPairPreferencesStore` merges the choice onto `pairings.cadence_override` (never replacing what roster import put there) and writes `pair.preferences_updated` in the same transaction. Every reader follows via `resolveCadence` — slot length, booking, nudge deficits, adherence. A `cooling` saga waits on the event, re-times its next proposal from the same `lastSessionAt`, and posts who changed what to the thread; in any other state the change simply shows in the next proposal (which now states the slot length), and the modal says exactly that rather than promising an announcement. The button and the "Each slot is N minutes" line appear only when the conversation adapter can render buttons — a proposal degraded to plain DMs mentions neither. A button left on an old proposal after the program turns choice off opens nothing (`preferences_disabled`), and a program turning it off mid-modal gets its own error, not "not part of this pair" (`update` returns `{ ok: false, reason }`). Migration `0013_cooling_preferences_wait.sql` backfills the event pattern onto sagas that were already in `cooling` before this shipped, without touching `version` or `updated_at`. **Not yet run against a live workspace**, and no admin view reads preference changes yet. |
| Integration registry, capability negotiation, degradation | Working, tested. On Postgres, ADR-0006's probe-and-cache is now real: `probeAndCacheCapabilities` (`packages/workflows/src/postgres-capabilities.ts`) is the only writer of `integration_bindings.capabilities` — run at worker boot (`Worker.probeCapabilities()`, from `main.ts`/`main-live.ts`) and, in `main.ts`, refreshed by the scheduler every `CAPABILITY_PROBE_INTERVAL_MS` (default 6h). A throwing or timed-out probe is recorded as `capabilities = null` with `last_error` and warned, never fatal; a slot with a row but no bound adapter is cleared; `PostgresSagaResolvers.capabilities()` stays read-only and, on a miss for a bound slot, warns once and degrades. Not built: re-probe on operation failure, and re-probe on an admin settings save (the API process holds no adapters — rejected in the file's comment). `main-live.ts` probes at boot only, since its loop never calls `worker.sweep()`. |
| Fake adapters | Working — used by tests and the demo |
| Postgres schema, RLS, `withTenant` | Working, tested. Migrations applied; the cross-tenant leak test proves the policy bites (`packages/db/src/__tests__/rls.test.ts`). |
| Outbox relay (`relayOnce` / `relayLoop`) | Working, tested — claim with `SKIP LOCKED`, at-least-once, backoff and dead-lettering. The admin-facing gap ROADMAP phase 1 named ("saga instances not advanced in N days; dead-letter review") is now closed: `listStuckSagaInstances`/`listDeadLetteredEvents` (`packages/workflows/src/postgres-reads.ts`, org-scoped, run inside `withTenant`) back `GET /orgs/:orgId/{stuck-sagas,dead-letters}` on `apps/api` — same `authenticateAdmin` 401/403 gating as risk-findings/nudges, `stuck-sagas` taking an optional `?days=` (default 3) and also listing, regardless of age, every instance the engine has parked as `failed` — rendered by `apps/web`'s `/dashboard/{stuck-sagas,dead-letters}` pages. Read-only: no acknowledge/replay action yet, same as risk-findings. |
| `PostgresSagaResolvers`, `PostgresEventSink`, `PostgresProjector` | Working, tested — the counterparts to testkit's `World`, including the projections that make read models appear. `PostgresEventSink` appends a keyed event once (`ON CONFLICT DO NOTHING` on `events_idempotency_key_unique`, returning the original row — proven under three concurrent writers in `postgres-sink.test.ts`), and `session.scheduled`'s projection writes one `sessions` row per calendar invite even if a pre-0014 duplicate event arrives with a fresh `sessionId`. |
| `createWorker` + `pnpm serve:worker` | Working, tested end to end and run by hand: a `pair.activated` row becomes a proposed, agreed and booked session on Postgres, driven by two real signed Slack clicks. Bound to the fake adapters, because Slack and Google have still never run live. The loop now has a third kind of tick alongside relay-drain and timer-fire: `worker.sweep()` (`apps/worker/src/scheduler.ts`'s `Scheduler`), called every iteration, runs the nudge, progress and digest sweeps each on its own configurable interval (`NUDGE_SWEEP_INTERVAL_MS`/`PROGRESS_SWEEP_INTERVAL_MS`/`DIGEST_INTERVAL_MS`), org-scoped, with an overlap guard so a slow sweep is never started twice and a failure backs off a full interval rather than retrying every tick. See the Nudge/Progress rows below for what each sweep actually does. |
| Journey suite (Tier 2, `tests/e2e/`) | Working — `pnpm test:e2e` (PR gate) and `pnpm test:e2e:nightly`. The first tests in the repo that run `apps/api` (a real socket, `buildPostgresApiDeps`, genuinely HMAC-signed Slack requests) and `apps/worker` (`createWorker`, its own pool) against one Postgres, both as the unprivileged `mentorship_app` role so RLS is live. Seeded through the real `planRosterImport`/`commitRosterImport` (or `commitMatchingRound`); after that a journey acts only through signed HTTP and a ticking journey clock, and asserts only on `events`, the adapter recorder and process logs. 19 catalogue rows from `docs/e2e-testing-strategy.md`: 16 built as journeys (some with variants — e.g. transcribed / no consent / no slot), 3 skipped with the reason written down (`declined` and `consent-revoked` have no human door; `calendar-never-confirmed` is unreachable from outside). Properties applied to every journey: P1 redelivery, P3 two orgs concurrently, P4 timeout totality (reads `saga_instances.history` only — the engine now records each step's `waitFor`/`timeoutAt`/`done` there), P5 determinism plus a fenced `LlmProvider` proving the model is reachable only from `extracting`; nightly adds P2 crash-resume (kill the worker at every adapter call, before and after the vendor acts, and on a restart before every pass). **It found product bugs; three (#4, #6, #10) since fixed, the rest still open** — each is asserted as the *correct* behaviour and marked `it.fails` (so fixing it turns the suite red until the marker goes): one-sided silence gets no renudge (invariant 11); a redelivered `pair.activated` restarts a *paused* saga (`SagaEngine.start` dedupes only running instances); the confirming-timeout render replaces the write-up with the "unverified" banner; a *failing* (not absent) DM slot wedged the lifecycle at the reminder and made every pass for the org throw (**since fixed** — per-instance isolation in `tick()`, and a DM that fails again on its retry degrades to not-sent-and-escalated, never the thread); and under P2 — a crash in a saga's first step strands it `running` in `idle` with no timeout, `emit` effects were not idempotent (duplicate `session.scheduled`/`session.held`/`pair.cadence_deficit` on retry — **since fixed**: every effect-produced event carries its effect key in `events.idempotency_key`, deduped by a partial unique index, migration `0014`, with the same semantics in `EventLog`; the nightly check for it is now a plain `it`), the confirming timeout can consume its own re-emitted `extraction.confirmed` as a verdict and re-arm for 120h, a first `render_document` retried after a crash creates a second doc (the Drive adapter ignores the key on create too), and the fetched transcript lives only in worker memory, so a restart between passes extracts from an empty string. Also surfaced, as seed-time stand-ins rather than tests: nothing in the repo wrote `integration_bindings.capabilities` (ADR-0006's probe-and-cache), so a real Postgres tenant read every slot as `null` — **since fixed** by the worker's boot probe, which the harness now runs instead of seeding the column (bug #10); and there is no Postgres `RosterSink` (`tests/e2e/harness/seed.ts` has the only one). No inbound route writes `feedback.submitted`, so a journey leaves `feedback` only by its window closing. |
| `PostgresSagaStore` | Working, tested — round-trip, optimistic concurrency under a real race, and parity with `MemorySagaStore`. Imported from `@mentorship/workflows/postgres` so the default entry stays driver-free. |
| Slack interaction endpoint, mounted behind `apps/api` (`node:http`) | Working, tested over a real socket with a genuine HMAC signature and against the actual saga. Runs on Postgres when DATABASE_URL is set (verified identity links, response and outbox event in one transaction) or on the in-memory world without one. `apps/api` runs no relay itself: on Postgres a click is recorded durably and the saga advances when `pnpm serve:worker` (`createWorker` → `relayOnce`) drains it from the same database — the two-process arrangement `tests/e2e/` runs on every journey. The Postgres wiring lives in `buildPostgresApiDeps` (`apps/api/src/postgres-deps.ts`), shared by `main.ts` and the journey harness. "Suggest another" now opens a real modal: the click calls `views.open` **synchronously, inside its own request** (`SlackWebApiModalOpener`, `packages/integrations/src/slack/modal.ts`), because the `trigger_id` expires in about three seconds — an effect run later by the relay would open nothing. The modal is a `datepicker` + `timepicker`, so a counter-proposal stays a structured fact and is never parsed out of prose (invariant 9); its `private_metadata` carries the agreement id. The `view_submission` that comes back arrives at the same route and is signature-verified the same way before anything else looks at it, then becomes a real `AgreementResponse.counter` — the first caller ever to populate a field core has always had — which `resolveAgreement` reads as `countered`, making the saga's (already correct, untouched) re-propose-and-cap path reachable. Bad input answers with Slack's `response_action: "errors"` against the offending block rather than failing silently. **Run against an actual workspace** (a sandbox one, `docs/live-tenant-testing.md`): propose → accept/counter → book, and "Suggest another" end to end — a real modal, a real UTC-converted counter, a real new round. That run also found a real bug, since fixed: `PostgresProjector.agreementOpened()` derived `pairing_id` from the event's subject ref, which for this one event is `agreement:<id>` (the `emit` effect re-subjects anything carrying an `agreementId`) rather than `pairing:<id>` — every agreement's `pairing_id` came out equal to its own `id`. Invisible until the counter modal's context lookup was the first thing to join *from* an agreement back to its pairing. Fixed by reading `pairingId` from the payload, which had always carried the correct value. |
| Slack Events listener (notes capture) + Confirm/Edit buttons | `POST /slack/events` on `apps/api`, and `ConversationAdapter.postConfirmation`. Working, tested — same raw-body signature discipline as the interaction route, the `url_verification` handshake answered only *after* that check, bot messages and message subtypes ignored, the Slack `ts` carried as `noteId` so a retry is a no-op (proven against Postgres), and a message from someone who is not a party to the pair refused rather than recorded as their notes. The verdict on an extraction now comes off **Confirm**/**Edit** buttons (`confirm_extraction:<id>` / `edit_extraction:<id>`) through the same "write the fact, 200, let the relay advance the saga" path as an agreement click — prose is never read as a verdict (invariant 9), and a typed "confirmed" in the thread is only ever a note. A message is attributed to a pair by channel id, which reaches `pairings.thread_ref` via the new `pair.thread_bound` event and its projection; without a bound thread the message is acked and dropped. **Never run against an actual workspace** — the scopes (`im:history`, `mpim:history`) and subscriptions (`message.im`, `message.mpim`) are declared in `docs/slack-app-manifest.json` and unexercised, and on Postgres the same two-process rule applies: the note is recorded, and the saga moves when the worker's relay drains it (exercised end to end by the `notes-inbound`, `stranger-notes` and `prose-is-never-a-verdict` journeys). |
| `SlackConversationAdapter`, `SlackDmAdapter`, `GoogleCalendarAdapter` | API shapes real; wired into `pnpm serve:worker:live` through `SandboxGuard`, which throws before any disallowed recipient reaches the transport (`live-registry.test.ts`, no network). **Run against an actual sandbox workspace and a real Google Calendar**: `conversations.open` on a real multi-party DM, `chat.postMessage` for proposals/reminders/pick-status/booked confirmations, `events.insert` with an idempotency-keyed id creating a real (unmailed, `sendUpdates: "none"`) invite, a reminder firing on the real calendar-verify path. Running this by hand against a shared local Postgres also surfaced an operational gap: the worker's timer scan was not scoped to its own `ORG_ID` — a due `saga_instances` row left over from a *different* org (e.g. an earlier live-tenant run against the same database) got claimed anyway, `pairContext()` threw `unknown pairing` under the wrong tenant, and since `SagaEngine.tick()` has no per-instance failure handling the whole pass aborted, ahead of anything that pass could otherwise deliver — reclaimed and re-thrown forever. **Fixed**: `SagaStore.findDue(now, orgId?)` now takes an optional org filter (both `MemorySagaStore` and `PostgresSagaStore`, `packages/workflows/src/store.ts` / `postgres-store.ts`), `SagaEngine.tick(orgId?)` threads it through, and `createWorker`'s `pass()` calls `engine.tick(options.orgId)` (`apps/worker/src/worker.ts`) — covered by a store-level test and an engine-level test, both asserting a same-tick foreign-org instance is left untouched. The relay's own claim query (`relayOnce` in `packages/workflows/src/relay.ts`) was already `orgId`-scoped and `createWorker` already passed its `orgId` there, so that half of the original note no longer applied by the time this was checked — only the timer scan needed the fix. Google auth no longer needs a manually re-pasted access token every hour: `GoogleAccessTokenSource` (`packages/integrations/src/google/auth.ts`) is a thunk both Google transports call per-request rather than a string closed over at boot, and `refreshableGoogleAccessToken` mints fresh access tokens from a refresh token automatically. `live-registry.ts` prefers `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` when all three are set, falling back to a static `GOOGLE_ACCESS_TOKEN` otherwise. |
| `GoogleDriveDocumentAdapter` (the running shared doc) | `packages/integrations/src/google/document.ts`. API shapes real, managed-region logic tested against replayed vendor fixtures (`tests/fixtures/vendor`, all still hand-written — `docs/vendor-contracts.md`) — create-from-guideline (Drive `files.copy`) vs blank-create-then-move, marker seeding, and replace-in-place that provably leaves everything outside the markers byte-identical (ADR-0005). Vendor config (`folderId`, `guidelineDocId`) lives on the new `integration_bindings.config` jsonb (migration `0010`), resolved at worker boot by `resolveDocumentConfig` — a DB row beats `GOOGLE_DRIVE_FOLDER_ID`/`GOOGLE_DRIVE_GUIDELINE_DOC_ID`, and the two are never merged. The doc's name comes from `policy.document.namingTemplate`, whose default renders exactly the string the saga used to hardcode. A configured `guidelineDocId` doubles as the org's playbook link: `PairContext.playbookUrl` carries it (null when unconfigured) and the proposal, the *shared* reminder and the private feedback request append one line each — the individual heads-up DMs deliberately do not, and an unconfigured org's message text is byte-identical to before, with a regression test pinning the literals. Access is granted, not assumed: `renderManagedRegion` takes `collaborators: { email }[]` on the *port* (vendor-agnostic — core never learns the word "writer") and the Drive adapter turns that into `permissions.create` with `role: "writer"`, after a `permissions.list` so a re-render neither piles up duplicate permission objects nor re-sends Drive's access-granted email; an unusable address is warned about and skipped rather than failing the whole render — but "unusable" is only ever a local, syntactic check (`EMAIL.test`), and a plus-addressed email passes it. Without this a copied doc is unreachable — Drive does not carry the guideline doc's sharing onto the copy. Not wrapped in `SandboxGuard` — it addresses a folder, not a person; the grant does address a person, but only ever the pair's own two emails, which the saga already messages. **Run against an actual Drive/Docs account** (`docs/live-tenant-testing.md`): create-from-guideline, managed-region write and the doc's URL all worked first try. `grantEditAccess` did not, against the sandbox's plus-addressed test emails specifically — Drive's `permissions.create` answers a genuinely distinct account, but returns `400 invalidSharingRequest` for `name+role@domain`, confirmed directly with `curl` (the bare address succeeds, the plus-addressed one does not). Not a bug here — the adapter calls the API correctly and Google's own service is the one refusing the address — but it means the plus-addressing this doc recommends for a two-person Slack test cannot double as the two Drive-sharing recipients; see the note under "Isolate the workspace" in that doc. Both ADR-0005 safeguards flagged as outstanding above are now built, closing the gap between them and this adapter's real writes: `resolveManagedRegionWrite` (`packages/core/src/document-projection.ts`) is the vendor-agnostic comparison — given the markdown we're about to render, the region's current content, what we last rendered ourselves, and an `isEcho` flag, it decides whether to render normally, render anyway (an echo of our own write, never a human edit), or preserve a genuine human edit untouched and report `pinned: true` on `DocumentAdapter.renderManagedRegion`'s result (a field the port interface now carries). `GoogleDriveDocumentAdapter` supplies the one Drive-specific fact core cannot know — whether the current revision was authored by us — via `isEchoRevision`, reading `lastModifyingUser.me` off Drive's `revisions.list`; `FakeDocument` tracks the same distinction in-memory for tests, with `humanEdit`/`simulateServiceEcho` test hooks standing in for a real human edit and a real echo respectively. The baseline ("what we last rendered") is process-local, in-memory state on the adapter instance, the same documented limitation `FakeCalendar`'s idempotency map already has — a worker restart forgets it, which just means the next render treats the region as untouched rather than silently misbehaving. Tested in `packages/integrations/src/__tests__/fake-document.test.ts` and `packages/integrations/src/__tests__/google-document.test.ts` ("echo suppression and pinning" in both). **Not yet run against a real Drive account** — `isEchoRevision`'s reliance on `revisions.list` reporting `lastModifyingUser.me` is unverified outside the stub. |
| `Primitive` contract, `LlmProvider` port, `packages/ai` | Working, tested. `runPrimitive` never throws because the model failed — refusal, timeout or a schema violation surviving one repair all end at the primitive's `fallback`, with the run recorded either way. Proved for session-intel specifically, with a hostile provider in each of those three modes, by `packages/primitives/session-intel/src/__tests__/hostile-provider.test.ts`. "Timeout" means the provider *throwing* one: `runPrimitive` has no deadline of its own, so a provider promise that never settles would hang the extraction — the Anthropic SDK's own timeout is the only bound today. |
| Vendor contract fixtures (tier 4) | `packages/integrations/src/contracts/` — a recording transport (redacts tokens, secrets, emails, Slack person ids; best-effort, never fails the live call) and a replay transport that refuses any request field no fixture recorded, any response field a fixture lacks, and any call with no fixture. Capture is wired into `live-registry.ts` behind `CAPTURE_VENDOR_FIXTURES=1`, **off by default**, under `SandboxGuard`. The Sheets, Drive-document (incl. `isEchoRevision`), Slack conversation/DM and Calendar adapter tests replay `tests/fixtures/vendor/**` (28 fixtures) and warn after each file about every hand-written or stale (`VENDOR_FIXTURE_MAX_AGE_DAYS`, default 90) fixture they were served. **Every fixture is `source: "hand-written"`** — seeded from the stubs they replaced, because no live credentials were available — so this dates the assumptions rather than verifying them. `pnpm test:contracts:live` (`tests/contracts/live/`) drives every call through `buildLiveRegistry` with capture on; it refuses to start without credentials and a two-member-plus-email `SANDBOX_ALLOWLIST`, and **has never been run** beyond confirming that refusal. The per-call sign-off table is `docs/vendor-contracts.md`. |
| Evals (tier 5) | `pnpm eval` (`evals/run.ts`, outside vitest's include, never in the gate). Runs the golden set and a new hand-labelled safeguarding set (`session-intel/src/__tests__/safeguarding-fixtures.ts`, 4 gentle disclosures + 4 hard negatives) through the real `runPrimitive`, and with `DATABASE_URL` reads `ai_runs` Confirm/Edit verdicts one org at a time inside `withTenant`. Reports action-item P/R, evidence-span validity against the unedited source (invariant 18), safeguarding recall/precision and accepted-as-is rate, grouped by `prompt_version` and model; `EVAL_REPORT_PATH` writes JSON. Without `ANTHROPIC_API_KEY` it scores the deterministic fallback and says so — safeguarding recall 0/4 by design (invariant 16). Exits 0 on any score, 1 on a harness error. Its scoring is pure and tested (`session-intel/src/eval-report.ts`); its DB read is tested against Postgres (`evals/__tests__/`). **Never run with a real key.** Limit: `ai_runs.input` is never written, so a stored run's spans can be shape-checked but not anchored. |
| Session intelligence | `packages/primitives/session-intel`. Working, tested — evidence spans, `safeguarding`-gates-to-`escalate`, deterministic fallback. Wired into `createWorker`/`bootstrap()`: pass `llm` (an `AnthropicProvider` in production, `ANTHROPIC_API_KEY`-gated; a `DeterministicProvider` in tests) and it replaces `heuristicSessionIntel` at the `extracting` state — omit it and the deterministic stub still runs, so nothing existing had to change. Pending-then-confirm is real: Slack's Confirm/Edit buttons write `extraction.confirmed`/`extraction.edited`, which now also becomes that extraction's `ai_runs.verdict` — `createPrimitiveSessionIntel` stamps a pre-generated extraction id onto the run as `subjectId` (migration `0012` adds the column), and `PostgresExtractionResponder` calls the new `AiRunSink.setVerdict` right after the domain event, best-effort so a label write can never fail the click. `safeguarding` is routed out of band: `effects.ts`'s `run_extraction` now surfaces the primitive's `gate`, and the `extracting` saga state branches on it before `render_document`/`request_confirmation` (which post into the pair's own thread) — a flagged extraction instead runs `notify_safeguarding`, DMing `policy.safeguarding.contactMemberRef` and emitting `safeguarding.flagged`; an unconfigured contact warns loudly rather than dropping the disclosure. |
| Matching | `packages/primitives/matching`. Working, tested — hard constraints, feature scorers (including `narrative_similarity`, cosine over embeddings a caller resolves up front with `embedNarratives` — live pgvector storage/query is not built, unverifiable in this sandbox), a capacity-aware min-cost-flow solver (beats greedy on coverage), and a bounded model adjudication pass on the shortlist only (invariant 17). `runMatchingRound`/`commitMatchingRound` (`round.ts`) turn assignments into pairings through the same sink shape `RosterSink` already uses (`World` satisfies it unchanged) — a matched pair produces the identical `pair.activated` an imported one does (ADR-0003), auto-committing only when policy has turned `requireAdminApproval` off. Not yet a saga and not yet callable from anywhere real: there is no cohort/enrolment data model yet to build a `MatchingPool` from (phase 0 gap), so this is exercised with hand-built fixtures, not a live cohort. The persisted candidate set now has a reader: `getMatchingRoundCandidates` (`apps/api/src/postgres-reads.ts`) pulls a round's full `MatchingOutput` back out of `ai_runs` by run id and marks each candidate `won` against `assignments`, behind `GET /orgs/:orgId/matching-rounds/:runId/candidates` (`authenticateAdmin`-gated) and rendered at `/dashboard/matching-rounds` — a run-id lookup, not a browsable list, since nothing yet indexes rounds by cohort. Constraint-satisfaction and coverage are also now a named, standalone suite rather than incidental coverage: `packages/primitives/matching/src/__tests__/invariants.test.ts` runs the same two properties `pipeline.test.ts` already asserted, but across 40 randomized seeded cohorts instead of hand-built fixtures, as part of the default `pnpm test`, and so of `.github/workflows/ci.yml`'s test step (which has not yet run on GitHub). |
| Nudge | `packages/primitives/nudge`. Working, tested — a deterministic temporal sweep turns absence into deficit events; every send passes a gate chain (mute/snooze, dedupe, privacy, already-booked, rate limit, quiet hours in the recipient's own zone) the model cannot override; a Thompson bandit picks templates. `runNudgeSweep` (`sweep.ts`) runs the planner per deficit, dispatches only on `gate === "auto"`, and records every outcome through `PostgresNudgeRecordSink` into the existing `nudges` table (an escalation, addressed to a human rather than a participant, is honestly skipped rather than forced into a `NOT NULL` column — the same gap invariant 16 already names for `safeguarding`). Now called by something real: `apps/worker`'s `Scheduler` ticks a nudge sweep on a configurable interval (`NUDGE_SWEEP_INTERVAL_MS`, default 15 minutes), org-scoped to the worker's own `ORG_ID`. `packages/primitives/nudge/src/postgres.ts` adds `PostgresNudgeReader` and `listCohortDeficitInputs` — real queries, but an honest MVP against the current schema: every recipient reads as unmuted and on the program-wide default quiet hours (no per-participant mute/snooze/quiet-hours columns exist yet), `history()` can only recover `sentDedupeKeys` (no `template_id`/`tone` column on `nudges` to reconstruct `delivered` from), and `templateStats()` is always `[]` (the bandit runs on a uniform prior rather than learning) for the same reason. `apps/worker/src/sweeps.ts` assembles the reader against a real `dm` adapter dispatch (`RegistryNudgeDispatchSink`, verified-chat-link-or-nothing, same rule as `pairContext`). |
| Progress & risk | `packages/primitives/progress`. Working, tested — health is a policy-weighted composite over present signals only (ADR-0007); risk is four named, evidence-carrying rules, not a classifier. `runProgressSweep` assesses a given list of pairings and writes every finding to a `RiskFindingsSink`; `PostgresRiskFindingsSink` (`./postgres`) persists to the new `risk_findings` table (migration `0006`/`0007`, RLS included). Now scheduled: `apps/worker`'s `Scheduler` ticks a progress sweep on a configurable interval (`PROGRESS_SWEEP_INTERVAL_MS`, default 15 minutes), one call per cohort (`listActivePairingsByCohort` in `./postgres`, since policy is per-cohort data and `runProgressSweep` takes one `policy` per call), org-scoped. `PostgresProgressReader` reads real `sessions`/`action_items`/`goals`/`goal_checkins` rows; `activity`, `surveys`, `responseLatencies` and `mentorPortfolio` stay honestly empty — nothing in the schema records them yet. There is now an admin view over `risk_findings` (`/dashboard/risk-findings`) but no acknowledgement workflow — it is a durable log surfaced read-only. A new scheduled digest (`apps/worker/src/digest.ts`, `DIGEST_INTERVAL_MS`, default hourly) reads this table plus `nudges` over a trailing window and persists a computed summary as a `digest.computed` event — there is no real notification channel yet, so today this means compute-and-persist, not send. |
| Authorization (visibility matrix) | `packages/core/src/authorization.ts` — pure, deterministic `authorize(actor, resource)`. No admin/program_lead branch on `feedback.sentiment` or a participant-attributed `signal` (invariant 14); `pairing.activity`/`risk-finding`/`nudge` visible to org-chart roles org-wide and to pair members for their own pairing; cross-org denied before any role check runs. Working, tested — `packages/core/src/__tests__/authorization.test.ts`, 26 cases including the invariant-14 one. Wired into `apps/api/src/server.ts`'s `handleAdminList`, gating `GET /orgs/:orgId/{risk-findings,nudges}` after `authenticateAdmin`. Not yet wired to anything pair-scoped — `apps/api` has no route that reads per-participant data and no session-to-pairing-membership resolution to build one on; that resolution is the next real exercise of this module, not a gap in the module itself. |
| Auth | `packages/auth` — magic-link only (SAML explicitly deferred: it needs a real external IdP this repo has no way to build or verify against, kept off the roadmap rather than half-built). Token/session logic against a `MagicLinkStore` port, `PostgresMagicLinkStore` backing it via `magic_links`/`auth_sessions` tables. Enumeration-safe by design; consuming a link is race-safe (an atomic `UPDATE ... WHERE consumed_at IS NULL`, not a check-then-write). Wired into real routes: `POST /auth/request-link` / `POST /auth/verify` on `apps/api`, which also now guard the admin read routes with a session + tenancy check (401/403) — previously unauthenticated. |
| Enrolment | `packages/enrollment` — `planInvite`/`commitInvite` (invite one person to a cohort+role, deduped) and `acceptInvite` (the identity-verification-at-enrolment item: records a verified identity link, flips a participant to `enrolled`). No schema change — built entirely on tables that already existed. First writer for the previously-unused `audit_log` table, via an optional `AuditSink`. Not wired into any HTTP route yet — nothing yet lets an admin actually send an invite. |
| Web app, dashboards | `apps/web` — Next.js App Router, Tailwind, shadcn/ui. The first frontend in this repo. `/login` + `/verify` drive `packages/auth`'s magic-link flow through real `apps/api` routes, preserving its enumeration-safety property on the client too (identical message on every outcome). `/dashboard/{risk-findings,nudges,stuck-sagas,dead-letters}` render the real tables, `/dashboard/matching-rounds` is a run-id lookup over a matching round's persisted candidates, `/dashboard/settings/document` writes the `document` slot's folder/guideline/naming-template through a PUT route gated by the same `authenticateAdmin` (401/403) the read routes use, and `/dashboard/settings/sheet` does the same for the `sheet` slot's folder/spreadsheet (see the sheet-sync row below). No `/auth/me` endpoint exists, so the dashboard layout answers "am I logged in" with a cheap probe request to a protected route. `/api/:path*` is proxied to `apps/api` (`next.config.ts`) so the browser only ever talks to one origin — no CORS configuration anywhere. **Browser-tested** (Tier 3 of `docs/e2e-testing-strategy.md`): `pnpm test:browser` runs six Playwright specs in `apps/web/e2e/` against `next build && next start`, a real `apps/api` on Postgres as `mentorship_app`, and two freshly seeded orgs — magic-link round trip (plus identical rendering for a known and an unknown email), unauthenticated redirect on every `/dashboard` route, the four read tables showing seeded rows, the matching-round lookup including not-found, document + sheet settings round-tripping through `integration_bindings` and a reload, and cross-tenant 403s. Needs a migrated Postgres; ports 18787/13000 (`E2E_API_PORT`/`E2E_WEB_PORT`) so it never collides with the dev servers. The raw magic-link token is read from the api's printed `[auth] magic link …` line, captured by the global setup — the database only ever holds its hash, and no test-only hook exists in product code. Not in any CI workflow from this change; `*.spec.ts`, so root `pnpm test` never runs it. |
| Program-progress → Google Sheets sync | New `sheet` slot: `SheetAdapter` port (`packages/core/src/capabilities.ts`, modeled on `DocumentAdapter`), `GoogleSheetsAdapter` (`packages/integrations/src/google/sheet.ts` — API shapes real, not run against a live Sheets account; create-then-move-into-folder via Drive, same two-step dance `GoogleDriveDocumentAdapter` uses, since Sheets' own `spreadsheets.create` cannot place a file in a folder) and `FakeSheet` (`packages/integrations/src/fakes.ts`) for tests/demo. Report types are a registry (`apps/worker/src/reports.ts`'s `REPORT_SOURCES` — `risk-findings` and `nudges` shipped, each a query inside `withTenant` shaped into primitive-valued rows by a pure, separately-tested function); adding a third is one new entry. `syncReports` creates the destination spreadsheet only when none is configured, then clears and rewrites each report type's tab in full on every sync — a deliberate full overwrite, never append/dedupe (append would need a stable row key every future report type can't promise, and an ever-growing sheet nothing prunes). No spreadsheet configured → the first sync creates one inside the org's Drive folder and persists the id back onto `integration_bindings` (slot `"sheet"`, the same upsert `PostgresDocumentSettingsStore.write` uses for `document`), so a second sync reuses it instead of creating a second spreadsheet — proven on Postgres (`apps/worker/src/__tests__/report-sync.test.ts`), including that it never reads a foreign org's rows. Scheduled exactly like the nudge/progress/digest sweeps: `Scheduler`/`worker.ts`'s `schedules.reportSync`, `REPORT_SYNC_INTERVAL_MS` (default hourly — a report tab is checked in on periodically, not something needing sub-minute freshness), org-scoped, off unless a `sheet` binding exists. `GET`/`PUT /orgs/:orgId/settings/sheet` (`apps/api`, `PostgresSheetSettingsStore`) and `apps/web`'s `/dashboard/settings/sheet` let an admin set the folder and, optionally, an existing spreadsheet — mirroring the `document` slot's settings pattern exactly. Bound in `apps/worker/src/live-registry.ts` alongside `GoogleDriveDocumentAdapter`, **not** wrapped in `SandboxGuard`, for the same reason that adapter is not: a report spreadsheet addresses a Drive folder, not a person. A `progress` report type (per-pairing health scores) was considered and deliberately left out — `computeHealth` (`packages/primitives/progress/src/health.ts`) is a pure function over `signals`, not a persisted, queryable row (ADR-0007: the model explains a score, nothing stores one for later reporting), and inventing a table to make it reportable would be the same "invent a fake email adapter" mistake `digest.ts`'s own comment warns against. |
| CI (`.github/workflows/`) | **Written, not yet run on GitHub.** `ci.yml` is the PR gate (every PR and push to `main`, `pgvector/pgvector:pg17` service): typecheck, `deps:check`, `db:migrate`, the full suite with `DATABASE_URL` via `scripts/assert-no-skipped.mjs` — which reads Vitest's JSON report and fails on any skipped test, because every Postgres suite is `skipIf(!DATABASE_URL)` and would otherwise vanish silently — then `test:e2e` and the `apps/web` build. `nightly.yml` (cron + dispatch) runs `test:e2e:nightly`, `test:browser`, `eval` and a `pnpm demo` smoke, one job each. `live-contracts.yml` is `workflow_dispatch` only, secrets in a `live-sandbox` environment, never on a PR. Every step was run by hand locally (827 tests, 0 skipped with the database; 95 skipped and exit 1 without it in CI mode) and the YAML is parse-checked, but no Actions run has happened. `test:e2e`, `test:e2e:nightly`, `test:browser`, `eval` and `test:contracts:live` are root scripts the workflows reference and other changes provide — a step whose script has not landed fails rather than passing vacuously. |

### Open review findings

From the code review of [PR #13](https://github.com/dhavalsharma/mentorship/pull/13#issuecomment-5830987735). None is fixed yet. Remove each line as it is fixed, the same way `it.fails` markers go.

- **A failed timer step's saved ledger can skip the *next* step's effects** (`engine.ts` `recordFailure`, high, reproduced). The partial `completedEffects` is saved with `stepIndex` and `awaitingEvent` unchanged. So an event-driven step at the same `stepIndex` sees its own keys (`{id}:{stepIndex}:{index}`) as done.
  - Example: a reminder whose DM throws after `verify_calendar_event` emitted `session.cancelled`. The re-proposal then skips `post_proposal` but still emits `agreement.opened`, so the saga waits on a proposal nobody saw.
  - This is the "ledger skips by index" risk the bug #4 fix noted, and it is reachable.
- **A retried timer step re-runs `step()` and re-mints ids** (`engine.ts`, medium, plausible). Completed effects are skipped by index, but later effects come from the new run. A proposal's buttons can then name `agr_A` while the saga waits on `agr_B`.
  - Fix together with the previous item: the saved ledger must not be able to collide with a different step. On retry, replay the recorded effect list rather than calling `step()` again.
- **`recordFailure` escalates even when its save lost the race** (`engine.ts`, low). A swallowed `SagaConflictError` still counts as `parked` and sends `saga_step_failed` about a saga another writer just advanced.
- **A parked (`failed`) saga can be restarted by a redelivered `pair.activated`** (`engine.ts` `start()`, low). It dedupes only `running` instances. Same class as open e2e bug #2.
- **`nightly.yml`'s `eval` job has no Postgres service** but runs `pnpm db:migrate` against `localhost:5432`, so it fails every night.
- **Fixture redaction misses Slack ids inside text** (`contracts/redact.ts`, low). Only whole-string ids match. A `<@U…>` mention in a captured message body would land in `tests/fixtures/vendor/` and in the `live-contracts.yml` artifact.

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
| [0009](docs/decisions/0009-pairs-choose-their-own-cadence.md) | Pairs choose their own session length and rhythm, from a structured control |

`docs/ROADMAP.md` has the build order and why it is in that order.
`docs/e2e-testing-strategy.md` has the testing one — what the 874 unit and
component tests already prove, what the journey suite added on top, the four things "end to end" has to mean here, and why the
process axis (two processes, one Postgres) is where the escaped bugs have
actually been.
