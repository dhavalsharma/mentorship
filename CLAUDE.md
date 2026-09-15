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
pnpm test        # 118 tests, ~2s, no database and no model
pnpm demo        # the full session cycle printed as a trace
pnpm serve:api   # the Slack interaction endpoint, live, seeded against testkit
pnpm typecheck

# the database-backed tests — 48 more, skipped above rather than failing
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
   `SagaResolvers`. *(Not yet enforced in CI — see the roadmap.)*

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
    is attributable; sentiment is not. *(No test — there is no reporting layer
    yet. Add the test with the layer.)*
15. **Notes are untrusted input.** A participant can paste anything into a
    note, including text shaped like instructions. Extracted content is never
    concatenated into a later prompt as instruction, and never authorises a
    tool call or a send.
16. **`safeguarding` bypasses everything** — no queue, no batching, no nudge.
    It reaches a named human out of band. *(Flag exists in the extraction
    schema; the routing is not built. Do not ship the flag without it.)*

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
| `SessionLifecycle` — all deterministic states | Working, tested |
| Roster import — parse, plan, validate, commit | Working, tested |
| Integration registry, capability negotiation, degradation | Working, tested |
| Fake adapters | Working — used by tests and the demo |
| Postgres schema, RLS, `withTenant` | Working, tested. Migrations applied; the cross-tenant leak test proves the policy bites (`packages/db/src/__tests__/rls.test.ts`). |
| Outbox relay (`relayOnce` / `relayLoop`) | Working, tested — claim with `SKIP LOCKED`, at-least-once, backoff and dead-lettering. |
| `PostgresSagaResolvers`, `PostgresEventSink`, `PostgresProjector` | Working, tested — the counterparts to testkit's `World`, including the projections that make read models appear. |
| `createWorker` + `pnpm serve:worker` | Working, tested end to end and run by hand: a `pair.activated` row becomes a proposed, agreed and booked session on Postgres, driven by two real signed Slack clicks. Bound to the fake adapters, because Slack and Google have still never run live. |
| `PostgresSagaStore` | Working, tested — round-trip, optimistic concurrency under a real race, and parity with `MemorySagaStore`. Imported from `@mentorship/workflows/postgres` so the default entry stays driver-free. |
| Slack interaction endpoint, mounted behind `apps/api` (`node:http`) | Working, tested over a real socket with a genuine HMAC signature and against the actual saga. Runs on Postgres when DATABASE_URL is set (verified identity links, response and outbox event in one transaction) or on the in-memory world without one. **No relay drains the outbox yet**, so on Postgres the click is recorded and the saga does not move. "Suggest another" acks but does not open a modal (ADR-0004's open gap). |
| `SlackConversationAdapter`, `SlackDmAdapter`, `GoogleCalendarAdapter` | API shapes real; wired into `pnpm serve:worker:live` through `SandboxGuard`, which throws before any disallowed recipient reaches the transport (`live-registry.test.ts`, no network). **Still never run against an actual workspace** — that is a credentials step, not a code one, per `docs/live-tenant-testing.md`. |
| `Primitive` contract, `LlmProvider` port, `packages/ai` | Working, tested. `runPrimitive` never throws because the model failed — refusal, timeout or a schema violation surviving one repair all end at the primitive's `fallback`, with the run recorded either way. |
| Session intelligence | Deterministic stub at the `SessionIntel` seam |
| Matching, nudge planner, progress & risk | Not started. |
| Web app, API, auth, authorization, dashboards | Not started |

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
