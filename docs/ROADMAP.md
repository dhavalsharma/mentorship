# Roadmap

The order matters more than the contents. Each phase depends on data or
structure the previous one creates, and two of the most important decisions
here are about what to build *late*.

**Where we are:** phase 0 mostly done (kernel contracts, roster import, magic-link
auth wired end to end into `apps/api`, enrolment/invite/identity-verification,
an audit log with its first writer, migrations applied and RLS verified),
phase 1 mostly done (saga engine, session lifecycle, integration profile,
Slack interaction endpoint, and now the Postgres store, relay and resolvers).
Every piece of the Postgres path exists and is tested; no process runs them
together yet. Phase 4's dashboard has a real first slice too: `apps/web`, a
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
      authenticating anyone itself — that's `packages/auth`'s job, called
      from wherever an HTTP route eventually links the two.
- [x] Cohorts, enrolment, invite flow — `packages/enrollment`'s
      `planInvite`/`commitInvite`: one admin, one email, one cohort, one role,
      deduped against a repeat invite. No schema change; built entirely on
      `cohorts`/`users`/`participants`/`identityLinks`, which already existed.
      Not wired into any HTTP route yet.
- [x] Audit log — the table existed with no writer until now. An optional
      `AuditSink` records `participant.invited`/`identity.verified` from
      `packages/enrollment`. Still no reader/admin view over it.

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
      engine saves with `WHERE version = $expected`. pg-boss still earns its
      place for cron-shaped work — the temporal sweep, when that exists.
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
      mocks (`packages/testkit/src/__tests__/slack-webhook.test.ts`). The
      "suggest another" button acks but does not open a modal yet — see
      ADR-0004's open gap.
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
      what the ports were for. **Nothing advances the saga on that path yet**,
      because the relay below is not built.
- [ ] Google Calendar adapter against a live tenant
- [ ] Slack adapter against a live workspace
      Both are blocked only on credentials now: `docs/live-tenant-testing.md`
      has the isolation plan, and `SandboxGuard` refuses any recipient not on
      an allowlist so a stray row cannot reach a colleague.
- [ ] Monitoring: saga instances not advanced in N days; dead-letter review.
      The relay's dead-lettering itself is real (`onDeadLettered`,
      `deadLetteredAt`, tested in `packages/workflows/src/relay.ts`) — what's
      missing is anything admin-facing: no route, no dashboard page, no query
      for "stuck N days" or a dead-letter list.
- [x] Nudge rate limits, dedupe keys, quiet hours — build before the first real
      notification, because retrofitting does not un-spam anyone.
      `packages/primitives/nudge` — the full gate chain, deterministic and
      model-proof. Not yet wired to send a real reminder.

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
- [ ] Document pinning and echo suppression (ADR-0005) before enabling real
      document writes
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
- [ ] A read model and appeal UI over those persisted candidates — nothing
      queries `ai_runs` for this yet
- [ ] Constraint-satisfaction and coverage assertions in CI — covered by
      `pipeline.test.ts` today; not yet a named CI gate
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
      durable log, not a queue — nothing schedules the sweep yet and there is
      still no admin view to read the table from.
- [ ] Structured goals; model-drafted, human-edited SMART framing
- [x] Read models for the dashboard — `GET /orgs/:orgId/risk-findings` and
      `GET /orgs/:orgId/nudges` in `apps/api` (`postgres-reads.ts`), gated by
      `authenticateAdmin` (session + org match, 401/403), rendered by
      `apps/web`'s `/dashboard/{risk-findings,nudges}` pages. No "pending
      matches" read model, since an approve-gated round has nowhere queryable
      to read from (Phase 3's own gap, not this one's).
- [ ] The same read model serving a scheduled digest — the query exists, but
      nothing calls it on a schedule yet; that's Wave 2's scheduler work.
- [ ] Authorization layer implementing the visibility matrix, **with tests** —
      including that individual feedback is never attributed outside the pair
- [ ] Fit the health weights against completed-cohort outcomes (ADR-0007)

## Phase 5 — Nudge planner and the open-source launch

- [x] Replace deterministic reminders with the planner plus a bandit over
      templates — now that there is outcome history to learn from.
      `packages/primitives/nudge` (`createNudgePlanner`, `ThompsonBandit`).
      `runNudgeSweep` runs it per deficit, dispatches on `gate === "auto"`,
      and records every outcome to the existing `nudges` table. Still nothing
      calls the sweep — no scheduler exists yet.
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
      codebase, catches a deliberate violation). Not yet wired into CI: no
      CI workflow exists anywhere in this repo yet for it to join.
- [ ] Full Apache-2.0 licence text
- [ ] A custom-primitive walkthrough, and the eval harness front and centre so
      contributors can change prompts safely

---

## Standing tasks

These are not a phase; they are things that go stale if ignored.

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
