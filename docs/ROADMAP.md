# Roadmap

The order matters more than the contents. Each phase depends on data or
structure the previous one creates, and two of the most important decisions
here are about what to build *late*.

**Where we are:** phase 0 mostly done (kernel contracts, roster import, magic-link
auth wired end to end into `apps/api`, enrolment/invite/identity-verification,
an audit log with its first writer, migrations applied and RLS verified),
phase 1 mostly done (saga engine, session lifecycle, integration profile,
Slack interaction endpoint, and now the Postgres store, relay and resolvers).
Every piece of the Postgres path exists and is tested, and `tests/e2e/` runs
`apps/api` and `apps/worker` together against one Postgres on every PR. Slack
and Google Calendar have run against a sandbox workspace. Phase 4's dashboard has a real first slice too: `apps/web`, a
Next.js admin app authenticated against the same magic-link flow, rendering
the risk-findings and nudges tables live from `apps/api`.

---

## Phase 0 — The kernel

The load-bearing wall. Everything after this assumes it.

- [x] Program policy schema, cadence resolution, pairing state machine
- [x] Roster import — the first pairing path, plan-then-commit
- [x] Drizzle schema with `org_id` on every table, RLS policies
- [x] **Apply the migrations.** `pnpm db:migrate` — a sixty-line runner over
      `packages/db/migrations`, applied from scratch and re-run idempotently.
- [x] Run the RLS verification query in `0002_rls.sql`. It bites — and doing it
      found that `withoutTenantIsolation` would have read *zero* rows rather
      than all of them, since FORCE RLS binds the owner too. Fixed in
      `0004_admin_policy.sql`.
- [x] Cross-tenant leak test in CI: two orgs, assert zero visibility
      (`packages/db/src/__tests__/rls.test.ts`, including the write path)
- [x] Auth adapter — magic link only, deliberately, for now. `packages/auth`:
      enumeration-safe request/verify against a `MagicLinkStore` port,
      race-safe consumption (atomic `UPDATE ... WHERE consumed_at IS NULL`),
      `PostgresMagicLinkStore` backing it (migration `0008`/`0009`, RLS
      included). Wired into real routes — `POST /auth/request-link` /
      `POST /auth/verify` on `apps/api` — which now also guard the admin read
      routes with a session + tenancy check. **SAML is intentionally deferred,
      not built**: it needs a real external IdP to integrate and test against,
      which does not exist in this environment; revisit when a pilot actually
      needs it rather than building it speculatively.
- [x] Identity mapping with a verification flow at enrolment — participant ↔
      chat member ↔ calendar account. `packages/enrollment`'s `acceptInvite`:
      records a verified `identityLinks` row, flips the participant to
      `enrolled`. Takes the verified identity as given rather than
      authenticating anyone itself — that's `packages/auth`'s job. Now linked
      over HTTP: following the magic link an invite issues *is* the
      verification — `POST /auth/verify` runs `acceptPendingInvites` for the
      signed-in user, recording an `email` identity and enrolling them.
      **Only the email is verified**; linking the Slack member id and the
      calendar account still needs each vendor's own sign-in (OAuth / "Sign
      in with Slack") and is not built.
- [x] Cohorts, enrolment, invite flow — `packages/enrollment`'s
      `planInvite`/`commitInvite`: one admin, one email, one cohort, one role,
      deduped against a repeat invite. No schema change; built entirely on
      `cohorts`/`users`/`participants`/`identityLinks`, which already existed.
      Wired: `POST /orgs/:orgId/invites` on `apps/api` (`authenticateStaff`,
      then `authorize()` on `enrolment.invite`, Zod body, cohort and role
      checked against this org's own data inside `withTenant`; 201 / 200
      dedupe / 400 field errors), a magic link issued per invite while the
      person is still `invited`, and `apps/web`'s `/dashboard/invites`.
- [x] **Staff roles** ([ADR-0010](decisions/0010-staff-role-is-granted-out-of-band.md)).
      A session used to authorize as `admin` on every admin route, so an
      invitee who followed their link got the dashboard and could invite
      others. Now `users.staff_role` (`admin` | `program_lead` | NULL,
      migration `0017`, no backfill) is read on every staff request by
      `authenticateStaff` through the required `StaffDirectory` port; a
      non-staff session is a 403 with the same body as a wrong-org one, and
      `authorize()` runs with the resolved role. Integration settings are a
      new admin-only resource. Granted out of band with `pnpm staff:grant`,
      audited as `staff.role_changed`; `apps/web` shows `/no-access` to a
      signed-in non-staff user.
- [ ] Grant and revoke staff roles from the dashboard, by an existing admin
      (admin-only route, same audit row). Today it is `pnpm staff:grant`
      only.
- [ ] Invite follow-ups, none needing a schema change: actually sending the
      link by email (it is printed today, like every magic link), a
      `GET` of cohorts/pending invites so the form need not take a cohort id,
      revoking an invite, and asking a new invitee for their zone (it
      defaults to UTC unless the admin supplies `tzOffsetMinutes`).
- [x] Audit log — the table existed with no writer until now. An optional
      `AuditSink` records `participant.invited`/`identity.verified` from
      `packages/enrollment`, now persisted by `PostgresAuditSink`
      (`apps/api/src/postgres-enrollment.ts`) in the same transaction as the
      rows it describes. Still no reader/admin view over it.

## Phase 1 — The spine and the session flow

- [x] Event log with the dispatcher/outbox pattern
- [x] Saga engine: idempotent effects, optimistic concurrency, timers, history
- [x] `SessionLifecycle` — every deterministic state
- [x] Integration profile, capability probing, degradation
- [x] Fake adapters for every slot
- [x] Postgres `SagaStore` — `@mentorship/workflows/postgres`. Kept off the
      package root so the default suite never loads the driver.
- [x] The outbox relay — `relayOnce` / `relayLoop` in
      `@mentorship/workflows/postgres`. Claims with `FOR UPDATE SKIP LOCKED`
      and holds the lock across delivery, so a crashed worker needs no lease
      expiry or sweeper. At-least-once by design; duplicates are absorbed by
      the effect ledger. A throwing subscriber backs off and is parked after
      `maxAttempts` rather than blocking the events behind it.
- [x] A worker that runs the relay and the timer tick — `createWorker` in
      `apps/worker`. One pass drains the outbox, then fires due timers. An
      end-to-end test takes a `pair.activated` row all the way to a booked
      session on Postgres.
- [x] Read-model projections as relay subscribers (`PostgresProjector`) —
      the counterpart to `World.project()`. Without it the saga emitted
      `agreement.opened` and no row appeared, so the response arriving two
      days later had nothing to attach itself to.
- [x] Schedule it — `pnpm serve:worker`, a polling loop with graceful
      shutdown. Not pg-boss, despite ADR-0008 naming it: its headline
      feature is making sure only one worker runs a job, and this loop does
      not need that, because the relay claims with `SKIP LOCKED` and the
      engine saves with `WHERE version = $expected`. The temporal sweep now
      exists (Phase 5) and still did not need pg-boss: `apps/worker/src/
      scheduler.ts`'s `Scheduler` is ordinary interval polling, gated
      in-process, on the same reasoning — every sweep underneath is itself
      idempotent, so two workers ticking it redundantly is merely wasteful,
      not unsafe.
- [ ] A relay that serves every tenant. Today's is scoped to one org because
      its resolvers are; a multi-tenant one has to build resolvers per event.
- [x] **Postgres `SagaResolvers`** — `pairContext`, `freeBusy`, `agreement`,
      `capabilities` over the real tables, the counterpart to `testkit`'s
      `World`. An unverified chat link is not a member ref, and absent or
      revoked consent is not consent.
- [x] Slack interaction endpoint — verify the signature, acknowledge inside the
      platform's deadline, write `agreement.responded`, advance asynchronously.
      `packages/integrations/src/slack/interactions.ts`; tested against a real
      HMAC signature and against the actual `SessionLifecycle` saga, not just
      mocks (`packages/testkit/src/__tests__/slack-webhook.test.ts`). "Suggest
      another" now opens a real `datepicker` + `timepicker` modal, synchronously
      in the click's request, and its submission becomes a structured
      `AgreementResponse.counter`.
- [x] Mount it behind a real HTTP server — `apps/api` (`node:http`, no
      framework: the route needs the exact raw bytes Slack signed, and a
      body-parser that touches them first breaks signature verification).
      `pnpm serve:api` runs it seeded against the in-memory testkit world;
      manually curled with a genuine signature and confirmed 200/401.
      `apps/api/src/__tests__/server.test.ts` exercises it over a real socket.
      Runs on Postgres when DATABASE_URL is set: verified `identity_links`
      for the clicking user, and the response recorded alongside its
      `agreement.responded` event in one transaction
      (`apps/api/src/postgres-ports.ts`). The route did not change — that is
      what the ports were for. The worker's relay drains the click and advances
      the saga — the two-process arrangement every `tests/e2e/` journey runs.
- [x] Pairs choose their own session length and rhythm (ADR-0009) — a
      "Session preferences" button on every proposal opens a Slack modal
      whose menu is `policy.pairPreferences` (default 15/30/45 minutes, every
      1–4 weeks, each with a custom value). Written to
      `pairings.cadence_override` with a `pair.preferences_updated` outbox
      event in one transaction; a cooling saga re-times its next proposal and
      tells the thread. Roster import gained a `duration` column. Tested
      in-memory and on Postgres; **not yet run against a live workspace**.
- [x] Surface pair preference changes to admins (ADR-0009 action 7) —
      `listPairPreferenceChanges` (`apps/api/src/postgres-reads.ts`) reads
      `pair.preferences_updated` off the event log inside `withTenant`, with
      the pair's names, who changed what, and the program + cohort default
      beside the result; `GET /orgs/:orgId/pair-preference-changes` (staff,
      `pairing.activity`) and `/dashboard/pair-preferences`, which marks a
      pair off the program default. The digest counts changes in its window.
      Read-only — no "reset to default" action.
- [x] Google Calendar adapter against a live tenant — `events.insert` with an
      idempotency-keyed id, a real (unmailed) invite, the reminder's
      calendar-verify path. Sandbox calendar, under `SandboxGuard`.
- [x] Slack adapter against a live workspace — `conversations.open`, proposals,
      reminders, pick status, booked confirmations and the "Suggest another"
      modal, in a sandbox workspace (`docs/live-tenant-testing.md`).
- [ ] What has still never run live: the Slack Events listener (notes capture
      and its `im:history`/`mpim:history` scopes), the Session preferences
      modal, Drive `isEchoRevision`, and keyed document creation via
      `appProperties`. `pnpm test:contracts:live` has never been run either.
- [x] Monitoring: saga instances not advanced in N days; dead-letter review —
      `listStuckSagaInstances`/`listDeadLetteredEvents`
      (`packages/workflows/src/postgres-reads.ts`, org-scoped, run inside
      `withTenant`), `GET /orgs/:orgId/{stuck-sagas,dead-letters}` on
      `apps/api` (same `authenticateStaff` 401/403 gating as risk-findings/
      nudges, `stuck-sagas` taking an optional `?days=`, default 3), and
      `apps/web`'s `/dashboard/{stuck-sagas,dead-letters}` pages. No
      acknowledgement/replay action yet — read-only, same as risk-findings.
- [x] Nudge rate limits, dedupe keys, quiet hours — build before the first real
      notification, because retrofitting does not un-spam anyone.
      `packages/primitives/nudge` — the full gate chain, deterministic and
      model-proof. Now wired to a real reminder: `apps/worker`'s scheduled
      nudge sweep (see Phase 5) calls it on an interval.

## Phase 2 — Session intelligence

The first real primitive. Build `packages/ai` alongside it: provider
abstraction, versioned prompt registry, `ai_runs`, structured output with one
repair retry, and the eval harness.

- [x] Replace `heuristicSessionIntel` with a schema-bound model call —
      `createWorker`/`bootstrap()` take an `llm: LlmProvider` and wire
      `createPrimitiveSessionIntel` in its place at the `extracting` state;
      omit it and the deterministic stub still runs, unchanged. Fixed a real
      bug this exposed: `run_extraction` never carried the note body through,
      so every notes-path extraction ran on empty text.
- [x] Keep the evidence spans — they are what makes a claim checkable
- [x] Pending-then-confirm UI — the Confirm/Edit buttons on a Slack extraction
      message (`confirm_extraction:<id>` / `edit_extraction:<id>`), the same
      write-the-fact-then-let-the-relay-advance-the-saga path as an agreement
      click (invariant 19: prose is never read as a verdict).
- [x] Confirmations become eval labels — `ai_runs` gained a `subjectId`
      column (migration `0012`) so a run can be found again by an
      extraction id; `runPrimitive`/`createPrimitiveSessionIntel` stamp it on
      write, and `PostgresExtractionResponder.respond` calls the new
      `AiRunSink.setVerdict` right after recording `extraction.confirmed` /
      `extraction.edited`, best-effort and outside that transaction so a
      label write can never fail the click itself.
- [x] Risk-flag routing for `safeguarding` — the effect runner's
      `run_extraction` now reads the primitive's `gate`, and the saga's
      `extracting` state branches on it *before* stage `render`: a
      safeguarding flag skips `render_document`/`request_confirmation`
      entirely (those post into the pair's own thread — exactly where a
      disclosure must not surface) and instead runs a new
      `notify_safeguarding` effect that DMs the org's configured
      `policy.safeguarding.contactMemberRef`, plus emits `safeguarding.flagged`
      for the durable record. An unconfigured contact warns loudly rather
      than silently dropping the disclosure — there is nowhere left to queue
      or batch it (invariant 16).
- [x] Document pinning and echo suppression (ADR-0005) before enabling real
      document writes — `resolveManagedRegionWrite`
      (`packages/core/src/document-projection.ts`), consumed by both
      `GoogleDriveDocumentAdapter` (Drive revision authorship via
      `isEchoRevision`) and `FakeDocument`
- [x] Golden fixtures; field-level precision/recall in CI — `eval.ts` +
      six hand-labelled cases in `golden-fixtures.ts`, scored against the
      deterministic fallback path on every `pnpm test` run. Measured:
      precision 1.00, recall 0.80. Scoped to `actionItems` only for now —
      blockers, goal progress and sentiment are meant to reuse the same shape.

Chosen as the first primitive deliberately: highest perceived value, lowest
risk, and it is the only one that *generates* the labelled data the others need.

## Phase 3 — Matching

`packages/primitives/matching` — built, tested, not yet called from any saga.

- [x] Hard constraints (capacity, timezone overlap, same-manager, opt-outs)
- [x] Feature scorers: directional skill fit, level-gap band, availability
      hours, narrative similarity — `narrative_similarity` is cosine over
      embeddings a caller resolves up front with `embedNarratives` and
      threads into `ScoringContext`, keeping the scoring loop synchronous.
      Live pgvector storage/query (the literal ask) is not built — nothing in
      this sandbox can verify it — and the scorer carries no default weight
      until it proves itself against a real cohort (invariant 17).
- [x] Capacity-aware global assignment — a solver, not greedy. Greedy is how
      mentee forty gets nobody while mentors sit under capacity.
- [x] LLM adjudication on the shortlist only, returning rationale and risk
      flags within bounds
- [x] Persist every candidate with its features and explanation — every pair
      the pipeline looked at (`CandidateRecord`, winners and losers) rides
      inside `MatchingOutput` and genuinely round-trips through
      `PostgresAiRunSink` into `ai_runs`, not just an in-memory shape.
- [x] A read model and appeal UI over those persisted candidates —
      `getMatchingRoundCandidates` (`apps/api/src/postgres-reads.ts`) reads a
      round's full candidate set (winners and losers, features, explanation,
      `won`) straight back out of `ai_runs` by run id, behind
      `GET /orgs/:orgId/matching-rounds/:runId/candidates`
      (`authenticateStaff`-gated, same as `risk-findings`/`nudges`).
      `/dashboard/matching-rounds` renders it as a table. No list of past
      rounds exists yet — it is a lookup by run id, not a browsable index —
      since nothing yet writes a round-to-cohort index a listing could read.
- [x] Constraint-satisfaction and coverage assertions in CI — named,
      standalone suite at
      `packages/primitives/matching/src/__tests__/invariants.test.ts`,
      asserting zero constraint violations, capacity never exceeded, and
      coverage at least matching a greedy baseline across 40 randomized,
      seeded cohorts. Runs as part of the default `pnpm test` (also runnable
      alone via `pnpm test:matching-invariants`), and so inside
      `.github/workflows/ci.yml`'s test step.
- [x] Commit a round into real pairings — `runMatchingRound`/
      `commitMatchingRound` (`round.ts`) turn assignments into `pair.activated`
      through the same sink shape `RosterSink` already uses; `World` satisfies
      it unchanged. Still nothing to call it: no cohort/enrolment model exists
      yet to build a `MatchingPool` from, so this runs against fixtures, not a
      live cohort — that gap is phase 0's, not this primitive's.

Deliberately after phase 2: match quality depends on profile depth that does
not exist on day one, and a mediocre first automated match spends credibility
before the platform has earned any. Roster import (ADR-0003) means nothing is
blocked while this waits.

## Phase 4 — Progress, risk, reporting

`packages/primitives/progress` — built, tested, not yet called from any saga.

- [x] `signals` contributors, cadence adherence first
- [x] Composite health score with density-derived confidence
- [x] Rules-plus-trend at-risk detection — `RiskFinding`s carry evidence and a
      `requiresHuman` flag, and now a home: `runProgressSweep` +
      `PostgresRiskFindingsSink` persist every finding to a new
      `risk_findings` table (migration `0006`/`0007`, RLS included). It is a
      durable log, not a queue, read-only at `/dashboard/risk-findings` (no
      acknowledgement workflow), and scheduled by the worker: see Phase 5.
- [ ] Structured goals; model-drafted, human-edited SMART framing
- [x] Read models for the dashboard; the same model serves the scheduled digest.
      A first slice exists end to end: `GET /orgs/:orgId/risk-findings` and
      `GET /orgs/:orgId/nudges` in `apps/api` (`postgres-reads.ts`, now
      session-authenticated), rendered by `apps/web`'s
      `/dashboard/{risk-findings,nudges}` pages. No "pending matches" read
      model, since an approve-gated round has nowhere queryable to read from
      (Phase 3's own gap, not this one's). The scheduled digest itself is
      `apps/worker/src/digest.ts`'s `runDigestSweep`: it queries exactly these
      two tables over a trailing window (default 24h) and persists a computed
      summary as a `digest.computed` domain event — there is still no real
      notification channel (no email, no Slack summary) to render it for a
      human, so today "digest" honestly means *compute-and-persist*, not
      *send*. A future channel is a subscriber away.
- [x] Authorization layer implementing the visibility matrix, **with tests** —
      `packages/core/src/authorization.ts`'s `authorize(actor, resource)`: pure,
      deterministic, no admin/program_lead exception on `feedback.sentiment`
      or a participant-attributed `signal` (invariant 14), org-chart roles and
      pair members both see `pairing.activity`/`risk-finding`/`nudge`,
      cross-org always denied first. 26 tests in
      `packages/core/src/__tests__/authorization.test.ts`, including the
      invariant-14 case CLAUDE.md flagged as missing. Wired into
      `apps/api/src/server.ts`'s `handleAdminList` — `GET
      /orgs/:orgId/risk-findings` and `/nudges` now call `authorize` after
      `authenticateStaff`, org membership no longer being read as "sees
      everything." Not yet wired to a route that reads anything pair-scoped
      (feedback sentiment, a per-participant `signal`), because none exists
      yet — there is no session-to-participant/pairing-membership resolution
      built in `apps/api` at all. That resolution, and the route it would
      gate, is the next real test of this module.
- [ ] Fit the health weights against completed-cohort outcomes (ADR-0007)

## Phase 5 — Nudge planner and the open-source launch

- [x] Replace deterministic reminders with the planner plus a bandit over
      templates — now that there is outcome history to learn from.
      `packages/primitives/nudge` (`createNudgePlanner`, `ThompsonBandit`).
      `runNudgeSweep` runs it per deficit, dispatches on `gate === "auto"`,
      and records every outcome to the existing `nudges` table. Something now
      calls the sweep: `apps/worker`'s `Scheduler` (`scheduler.ts`) adds a
      periodic, interval-gated tick alongside the existing relay-drain/timer
      pass — `pnpm serve:worker`'s loop calls `worker.sweep()` every
      iteration, and each configured job (`nudge`, `progress`, `digest`) only
      actually runs once its own interval has elapsed, org-scoped to the one
      `ORG_ID` that worker process serves (matching the fix already made for
      `SagaStore.findDue`). `createNudgeSweepRunner`/`createProgressSweepRunner`
      (`apps/worker/src/sweeps.ts`) assemble the real Postgres-backed
      `NudgeReader`/`ProgressReader` and dispatch through the bound `dm`
      adapter — with three honest, documented schema gaps: no
      per-participant mute/snooze/quiet-hours columns yet (every recipient
      reads as unmuted, on the program-wide default quiet hours), no
      `template_id`/`tone` column on `nudges` yet (so the bandit always runs
      on a uniform prior rather than learning from outcomes), and no survey
      table yet (`survey.unanswered` never fires). None of these are silent —
      each is called out in `packages/primitives/nudge/src/postgres.ts`.
      Not pg-boss, for the same reason the relay/timer loop already isn't
      (ADR-0008): nothing here needs a single-runner guarantee strongly
      enough to be worth a distributed lock, since every sweep underneath is
      itself idempotent.
- [x] Two or three presets (university, corporate career, founder network) as
      pure policy data. The real test of ADR-0001. `packages/core/src/presets.ts`
      (`PROGRAM_POLICY_PRESETS`), tested in `presets.test.ts`. Held up, with
      two real schema gaps found and closed as data, not branches:
      `ProgramPolicySchema` had no shape for what a goal is (`goals`, new) and
      no field for matching weights at all (`matching`, an untyped
      passthrough — core still cannot import `MatchingPolicySchema`, see the
      field comment in `policy.ts` and `readMatchingPolicy` in
      `packages/primitives/matching/src/policy.ts`).
- [ ] Public API and webhooks
- [ ] Docs site
- [x] `dependency-cruiser` enforcing the boundary rule — `.dependency-cruiser.cjs`
      + `pnpm deps:check`, verified both directions (clean against the real
      codebase, catches a deliberate violation). A step in
      `.github/workflows/ci.yml`, which passes on GitHub.
- [ ] Full Apache-2.0 licence text
- [ ] A custom-primitive walkthrough, and the eval harness front and centre so
      contributors can change prompts safely
- [x] Sync program-progress data into a Google Spreadsheet. `risk-findings`
      and `nudges` report types (`apps/worker/src/reports.ts`'s `REPORT_SOURCES`
      registry — one new file/function to add a third), a new `SheetAdapter`
      port (`packages/core/src/capabilities.ts`) with a real
      `GoogleSheetsAdapter` (`packages/integrations/src/google/sheet.ts`,
      create-then-move-into-folder via Drive, same dance
      `GoogleDriveDocumentAdapter` uses) and a `FakeSheet` for tests/demo.
      One spreadsheet per org, one tab per report type, full overwrite on
      every sync (never append/dedupe — see the comment on
      `syncReports`). No spreadsheet id configured → the first sync creates
      one in the org's Drive folder and persists the id back onto
      `integration_bindings` (slot `"sheet"`), so a second sync reuses it —
      proven on Postgres in `apps/worker/src/__tests__/report-sync.test.ts`.
      Scheduled the same way the nudge/progress/digest sweeps are
      (`Scheduler`/`worker.ts`, `REPORT_SYNC_INTERVAL_MS`, default hourly,
      org-scoped). `/orgs/:orgId/settings/sheet` (admin-gated, mirrors
      `/settings/document`) and `apps/web`'s `/dashboard/settings/sheet` let
      an admin configure the folder and, optionally, an existing
      spreadsheet. A `progress` report type was considered and left out:
      there is no persisted, queryable health score anywhere yet (ADR-0007 —
      the model explains a score, nothing stores one for later reporting),
      and inventing a table for it would be the same mistake `digest.ts`'s
      own comment warns against for a fake email adapter.

---

## Standing tasks

These are not a phase; they are things that go stale if ignored.

- CI now exists — `.github/workflows/ci.yml` (PR gate: typecheck,
  `deps:check`, migrations, the full suite with `DATABASE_URL` through
  `scripts/assert-no-skipped.mjs` so a skipped test fails, `test:e2e`, the web
  build), `nightly.yml` and `live-contracts.yml` (manual only). `ci.yml` has
  run green on GitHub — on PR #13 and on the merge to `main`. Still
  outstanding: `nightly.yml` has never run (trigger it once by hand), and
  `Gate` is not a required status check on `main`, because GitHub refuses
  branch protection on a private repo without a paid plan. Until it is, the
  gate can be merged past — a workflow that can be merged past guards nothing. See
  "CI — the gate" in [e2e-testing-strategy.md](./e2e-testing-strategy.md).
- Keep the journey suite (`tests/e2e/`, tier 2) growing with every new flow.
  It is the only thing that runs `apps/api` and `apps/worker` together against
  one Postgres, which is the shape every escaped composition bug has had.
- Keep the status table in `CLAUDE.md` and `README.md` honest. It is the first
  thing a contributor reads and the fastest way to lose their trust.
- Add an ADR when a decision could reasonably have gone the other way. Record
  the rejected option, not just the choice.
- Replace `tzOffsetMinutes` with IANA zones resolved per instant before any
  cohort spans a DST boundary.
- Every new adapter owes a real `probe()`, not a guess.
- ~~A malformed `programs.policy` silently becomes the default program.~~
  **Fixed.** `StoredProgramPolicySchema` in `packages/core/src/policy.ts`
  requires `consent.aiProcessing`/`consent.recording` explicitly (no
  `.default()`); `PostgresSagaResolvers.pairContext` now throws rather than
  silently defaulting. `defaultPolicy({})` and every other caller of the
  lenient `ProgramPolicySchema` are unchanged.
