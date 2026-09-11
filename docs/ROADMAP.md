# Roadmap

The order matters more than the contents. Each phase depends on data or
structure the previous one creates, and two of the most important decisions
here are about what to build *late*.

**Where we are:** phase 0 partially done (kernel contracts, roster import),
phase 1 mostly done (saga engine, session lifecycle, integration profile,
Slack interaction endpoint), with the persistence layer written but never run.

---

## Phase 0 — The kernel

The load-bearing wall. Everything after this assumes it.

- [x] Program policy schema, cadence resolution, pairing state machine
- [x] Roster import — the first pairing path, plan-then-commit
- [x] Drizzle schema with `org_id` on every table, RLS policies
- [ ] **Apply the migrations.** Nothing has touched a live database yet.
- [ ] Run the RLS verification query in `0002_rls.sql`. Do not assume it bites.
- [ ] Cross-tenant leak test in CI: two orgs, assert zero visibility
- [ ] Auth adapter (SAML for universities, magic link for small teams)
- [ ] Identity mapping with a verification flow at enrolment — participant ↔
      chat member ↔ calendar account. Boring, and the thing that blocks a pilot
      if it is missing.
- [ ] Cohorts, enrolment, invite flow
- [ ] Audit log

## Phase 1 — The spine and the session flow

- [x] Event log with the dispatcher/outbox pattern
- [x] Saga engine: idempotent effects, optimistic concurrency, timers, history
- [x] `SessionLifecycle` — every deterministic state
- [x] Integration profile, capability probing, degradation
- [x] Fake adapters for every slot
- [ ] Postgres `SagaStore`
- [ ] pg-boss wiring for the timer tick
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
      **Still backed by testkit, not Postgres** — swapping `harness.world` for
      real `identity_links` / `agreements` queries is the remaining step, and
      the route itself does not change when that happens.
- [ ] Google Calendar adapter against a live tenant
- [ ] Monitoring: saga instances not advanced in N days; dead-letter review
- [ ] Nudge rate limits, dedupe keys, quiet hours — build before the first real
      notification, because retrofitting does not un-spam anyone

## Phase 2 — Session intelligence

The first real primitive. Build `packages/ai` alongside it: provider
abstraction, versioned prompt registry, `ai_runs`, structured output with one
repair retry, and the eval harness.

- [ ] Replace `heuristicSessionIntel` with a schema-bound model call
- [ ] Keep the evidence spans — they are what makes a claim checkable
- [ ] Pending-then-confirm UI; confirmations become eval labels
- [ ] Risk-flag routing, including the `safeguarding` out-of-band path. **Do not
      ship the flag without the routing.**
- [ ] Document pinning and echo suppression (ADR-0005) before enabling real
      document writes
- [ ] Golden fixtures; field-level precision/recall in CI

Chosen as the first primitive deliberately: highest perceived value, lowest
risk, and it is the only one that *generates* the labelled data the others need.

## Phase 3 — Matching

- [ ] Hard constraints (capacity, timezone overlap, same-manager, opt-outs)
- [ ] Feature scorers: directional skill fit, level-gap band, availability
      hours, narrative cosine via pgvector
- [ ] Capacity-aware global assignment — a solver, not greedy. Greedy is how
      mentee forty gets nobody while mentors sit under capacity.
- [ ] LLM adjudication on the shortlist only, returning rationale and risk
      flags within bounds
- [ ] Persist every candidate with its features and explanation, for appeals
- [ ] Constraint-satisfaction and coverage assertions in CI

Deliberately after phase 2: match quality depends on profile depth that does
not exist on day one, and a mediocre first automated match spends credibility
before the platform has earned any. Roster import (ADR-0003) means nothing is
blocked while this waits.

## Phase 4 — Progress, risk, reporting

- [ ] `signals` contributors, cadence adherence first
- [ ] Composite health score with density-derived confidence
- [ ] Rules-plus-trend at-risk detection into an admin queue
- [ ] Structured goals; model-drafted, human-edited SMART framing
- [ ] Read models for the dashboard; the same model serves the scheduled digest
- [ ] Authorization layer implementing the visibility matrix, **with tests** —
      including that individual feedback is never attributed outside the pair
- [ ] Fit the health weights against completed-cohort outcomes (ADR-0007)

## Phase 5 — Nudge planner and the open-source launch

- [ ] Replace deterministic reminders with the planner plus a bandit over
      templates — now that there is outcome history to learn from
- [ ] Two or three presets (university, corporate career, founder network) as
      pure policy data. The real test of ADR-0001.
- [ ] Public API and webhooks
- [ ] Docs site
- [ ] `dependency-cruiser` enforcing the boundary rule in CI — the rule is only
      real if CI fails when it is broken
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
