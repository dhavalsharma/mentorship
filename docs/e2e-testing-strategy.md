# End-to-end testing strategy

> **Status (Tier 2 built).** `tests/e2e/` now exists: `pnpm test:e2e` runs 16
> journeys with P1/P3/P4/P5 applied to each, and `pnpm test:e2e:nightly` adds
> P2. It found ten product bugs on its first run — see
> [What the journey suite found](#what-the-journey-suite-found). The text below
> is the strategy as written before it was built, kept because it is the
> argument; where the build departed from it, the departure is noted.

827 tests pass. None of them is an end-to-end test.

That is not a criticism of the suite — it is very good at what it does, and
what it does is prove each piece in isolation against a seam. But every bug
that has actually escaped this codebase so far lived *between* two proven
pieces, and the two most expensive ones are worth naming up front because they
are the shape of everything this document is about:

- `PostgresProjector.agreementOpened()` derived `pairing_id` from the event's
  subject ref, which for that one event is `agreement:<id>`. Every agreement's
  `pairing_id` equalled its own id. The projector's tests passed. The
  resolvers' tests passed. It surfaced only when the counter modal became the
  first caller to join *from* an agreement back to its pairing — and it
  surfaced in a live Slack workspace, by hand, not in CI.
- `SagaStore.findDue` was not scoped to an org. A leftover row from a
  different tenant was claimed anyway, `pairContext()` threw under the wrong
  org, and `SagaEngine.tick()` aborted the whole pass — forever. Every
  component was correct. The composition was not.

Both are composition bugs. Both were found by a human running the system.
The purpose of this strategy is to make the machine find the next one.

---

## What "end to end" has to mean here

Four different things get called end-to-end testing, and conflating them is
why teams build one suite that proves none of them. This system has four
genuinely distinct axes, each with its own failure mode and its own cost:

| Axis | The question it answers | Today |
| --- | --- | --- |
| **Business flow** | Does a pair get from `pair.activated` to a documented, confirmed session and round again? | `pnpm demo` walks it, in memory, and **prints** rather than asserts |
| **Process** | Do `apps/api` and `apps/worker`, as separate processes sharing only Postgres, produce the right outcome? | **Nothing.** No test runs both |
| **Interface** | Does a human clicking in Slack or in the dashboard reach the right code? | Slack: yes, over a real socket with a real HMAC. Web: nothing above `lib/` |
| **Vendor** | Do Slack and Google behave the way the stubs say? | Manual, partial, documented in [live-tenant-testing.md](./live-tenant-testing.md) |

A fifth thing is often smuggled into an E2E suite and must not be: **does the
model get the extraction right.** That is an eval. It is nondeterministic, it
is slow, it costs money per run, and putting it in the gate means the gate
goes red for reasons unrelated to the change. It gets its own command and its
own section below, and it never blocks a merge.

The ordering above is also the priority order. The process axis is where the
bugs are, it is the cheapest to close, and almost all of the machinery for it
is already in the repo.

---

## Why this system can have a deterministic E2E suite

Most E2E suites are slow and flaky because the system under test is. This one
is not, and it is worth being explicit about which design decisions bought
that — because each one is now load-bearing for testing and breaking it costs
more than it looks like it costs.

1. **Only two saga states are model-driven** (invariant 8). Every other
   transition is a pure function of state and input. A journey through the
   whole lifecycle has exactly two points of nondeterminism, and both are
   behind a `Primitive` whose `fallback` is deterministic — so a journey run
   without an `llm` is fully deterministic end to end.
2. **Time is injectable.** `SagaEngine`, `createWorker` and
   `PostgresEventSink` all take `now?: () => Date`. "Wait two days for the
   renudge" is an assignment, not a `sleep`. There is no reason for a test in
   this repo to ever contain a timeout.
3. **The worker's loop is separable from a pass.** `worker.pass()` does one
   drain-then-tick and returns counts. `apps/worker/src/main.ts` is the only
   thing that wraps it in a `while`. A test drives passes explicitly, so
   there is no polling and no race with a background interval.
4. **Effects are idempotent by key** (invariant 6). Which means a test may
   replay the entire event log a second time and assert the externally
   visible behaviour is identical — a property, not a scenario.
5. **Every tenant table carries `org_id` and RLS enforces it** (invariant 3).
   A journey that seeds a fresh `randomUUID()` org cannot see or be seen by a
   journey running in parallel in the same database. E2E tests here can run
   concurrently against **one** Postgres with no per-test schema, no
   truncation between tests, and no serialisation. This is a real and unusual
   advantage; exploit it.
6. **The event log is the contract.** Assertions go against `events` and the
   adapter `Recorder`, not against internal saga state. A refactor that
   changes state names without changing what a participant sees should not
   turn the suite red.

The corollary is a rule: **if an E2E test needs a sleep, a retry, or a
`Math.random`, something upstream has broken one of these six and that is the
bug to fix.**

---

## The baseline, honestly

| Tier | What it is | Count | Runs in |
| --- | --- | --- | --- |
| 0 | Unit and contract tests, no infrastructure | 690 | ~5s |
| 1 | Postgres-backed component tests (RLS, store, relay, projector, resolvers, API routes over real sockets) | 95 | ~5s with `DATABASE_URL` |
| 2 | **Journey tests — full stack, two processes, real Postgres** (`pnpm test:e2e`) | 153 passing, 3 skipped with reasons — 16 journeys, each with P1/P3/P4/P5; 7 of the 153 are `it.fails` pinning a known bug | ~15s |
| 2n | Nightly: P2 crash-resume across the catalogue (`pnpm test:e2e:nightly`, adds to the above) | 41 — 18 crash sweeps, 18 restart-every-pass runs, 5 `it.fails` known bugs | ~2 min |
| 3 | **Browser journeys against `apps/web`** | 0 | — |
| 4 | **Vendor contract fixtures** | 0 | — |
| 5 | Evals over the AI primitives | partial (10 golden cases in `session-intel`) | ~5s |
| — | **CI running any of it** | none — no workflow file exists | — |

Tier 1 is stronger than the name suggests: `apps/worker/src/__tests__/worker.test.ts`
already takes a `pair.activated` row to a proposed session on Postgres, and
`apps/api/src/__tests__/postgres-slack-events.test.ts` already posts a
genuinely signed payload over a real socket. They are one harness apart from
being the same test, and nothing joins them.

That was true when this was written. `tests/e2e/harness/stage.ts` is the
harness that joins them.

---

## Tier 2 — journey tests

This is the whole strategy. Everything else is support.

### The rule that makes it end-to-end

> A journey touches Postgres **only to seed**. After that it acts only through
> the two doors a human has — an HTTP request, and the passage of time — and
> observes only through the two surfaces an operator has — the event log, and
> the adapter recorder.

No journey imports a repository, calls a saga, or asserts on `saga_instances.state`.
The moment one does, it stops being an end-to-end test and becomes an
integration test with more setup, and it will start passing while the system
is broken. That rule is the entire difference between this suite catching the
projector bug and not catching it.

### The harness

New package `tests/e2e/`, in the workspace, with the existing `@mentorship/*`
aliases. Sketch:

```ts
// tests/e2e/stage.ts
export interface Stage {
  /** Move the clock. Due timers fire on the next drain. */
  advanceTo(iso: string): void;
  /** worker.pass() until a pass reports nothing delivered and no timer fired. */
  drain(): Promise<void>;
  /** A real signed POST to the real listening socket. */
  click(who: Party, action: string, value: string): Promise<Response>;
  submitModal(who: Party, view: SlackView): Promise<Response>;
  /** A real signed Slack events POST — inbound notes. */
  say(who: Party, channel: string, text: string): Promise<Response>;

  /** Assertion surfaces — and the only two. */
  events(): Promise<DomainEvent[]>;
  calls(): RecordedCall[];
}

export async function stage(journey: Journey): Promise<Stage>;
```

`stage()` does the assembly that no test does today:

1. `connectTestDb()` against the one shared Postgres, `randomUUID()` org.
2. Seed via the *real* path — `planRosterImport` / `commitRosterImport`, or
   `commitMatchingRound`, never hand-written INSERTs. ADR-0003 says both
   produce the same `pair.activated`; a journey should be able to take either
   and not notice, and a parameterised journey pair is the test of that.
3. `createServer(postgresDeps)` on `listen(0)` — the same wiring
   `apps/api/src/main.ts` builds, not a bespoke one. The strongest version of
   this imports a shared `buildApiDeps(db, orgId)` extracted from `main.ts`,
   so the thing under test is the thing that ships.
4. `createWorker({ db, orgId, registry, now: () => clock })` with fakes bound
   through a `Recorder`.
5. Return a `Stage` closed over all of it.

Cost of building it: one file, ~200 lines, no new dependencies. Everything it
calls already exists and is already used this way somewhere in the suite.

### The journey catalogue

Each row is one file. The invariant column is what turns red when it breaks.

| Journey | Proves | Inv. |
| --- | --- | --- |
| `happy-path` | activated → propose → both accept → book → remind → hold → extract → confirm → feedback → cool → propose again | 5, 19 |
| `import-vs-match` | the same journey seeded by roster import and by a committed matching round is indistinguishable | ADR-0003 |
| `one-sided` | one accepts, one silent → exactly one renudge → `paused: one_sided_response` | 11 |
| `no-response` | neither responds → `paused: no_response`, no booking | 9 |
| `counter-then-cap` | counters through the real modal, twice, then `paused: negotiation_exhausted` | 9, 10 |
| `conflict` | both accept different slots → thread says who picked what → re-offer | — |
| `declined` | `paused: declined`, nothing booked | 9 |
| `no-mutual-availability` | IST/PST pair → `paused: no_mutual_availability`, and **no slot is ever offered outside either party's working hours** | 21 |
| `calendar-never-confirmed` | `create_calendar_event` runs but `session.scheduled` never arrives → `paused: calendar_never_confirmed` | 5, 7 |
| `no-transcription` | tenant without the capability never polls, reaches `session.undocumented` — a flow branch, not a runner degradation | 6 (ADR-0006) |
| `notes-inbound` | a real signed `message.mpim` becomes `notes.submitted` and drives `extracting`; the same `ts` twice is a no-op | — |
| `stranger-notes` | a message from someone not party to the pair is refused, not recorded | 15 |
| `prose-is-never-a-verdict` | "confirmed" typed in the thread stays a note; only the button writes `extraction.confirmed` | 9 |
| `safeguarding` | flagged extraction runs `notify_safeguarding` and **never** `render_document` or `request_confirmation` | 16 |
| `safeguarding-unconfigured` | an unset contact warns loudly; the disclosure is not dropped or posted to the pair | 16 |
| `extraction-timeout` | auto-confirm lands, marked **unverified** | 19 |
| `dm-outage` | the `dm` adapter throws for every call → the feedback request is **not** posted to the joint thread | 13 |
| `consent-revoked` | revoking recording consent changes the *next* invite, not only the extraction | 12 |
| `document-pinned` | a human edit inside the managed region survives the next render; an echo of our own write does not pin | ADR-0005 |

Nineteen files. They share one harness and differ mostly in `script`.

### The cross-cutting properties — where the leverage is

Five functions, applied to **every** journey above, parameterised. Nineteen
journeys times five properties is ninety-five assertions out of five
implementations, and four of the five have no scenario-specific code at all.

- **P1 · Idempotency.** Re-deliver every relayed event a second time and
  re-run the journey's drains. Assert `calls()` is identical in length and
  content. This is invariant 6 stated as a property instead of trusted.
  Catches: a new effect added without an idempotency key.
- **P2 · Crash resume.** For each pass index *n* in the journey, run a variant
  that throws inside the adapter on pass *n*, restart the worker, and finish.
  Assert the final event log and `calls()` match the uninterrupted run.
  Catches: the entire class of bug the saga engine exists to prevent, and
  currently nothing tests it. This is the most valuable single test in this
  document. Nightly, not per-PR — it is *O(passes)* per journey.
- **P3 · Tenant isolation.** Run the journey in org A and org B concurrently
  against the same database. Assert neither org's recorder ever sees the
  other's refs, and each org's `events` contains only its own. Catches
  exactly the `findDue` bug, and catches it in CI rather than in a live run.
- **P4 · Timeout totality.** Every state entered during the journey had a
  `waitFor`, a `timeoutAt`, or `done`. Invariant 7 has no test today; this
  gives it one, for free, across every journey. Catches: a new state added to
  the union and handled in the switch without a timeout.
- **P5 · Determinism.** Run the journey twice with the same clock and the same
  `sequentialIds`. Diff the event logs. Any difference is either genuine
  nondeterminism or a leaked `Date.now()`, and both are bugs. Also the
  cheapest possible guard on invariant 8: wire an `llm` that throws if called
  from any state other than `proposing` or `extracting`.

P4 and P5 are the ones worth building first, because they are pure
observation — they need no journey-specific assertions, so they start paying
the moment the second journey exists.

---

## Tier 3 — browser journeys

`apps/web` has 19 tests, all of them over `lib/`. Every page, every fetch,
every redirect and the whole auth round trip are untested. But the ceiling
here is low and the temptation is to overbuild, so: **six specs, and a rule
that the count does not grow without a bug to justify it.**

Playwright, added to `apps/web` only, against `next build && next start` with
`apps/api` and a seeded Postgres behind it.

1. **Magic link round trip.** `POST /auth/request-link`, read the token *from
   the database* (there is no email infrastructure — `main.ts` prints it), hit
   `/verify`, land on the dashboard. Assert the same message renders for a
   known and an unknown address — the enumeration-safety property is claimed
   for the client too, and nothing checks it.
2. **Unauthenticated redirect.** Each `/dashboard/*` route without a session.
3. **The four read tables** render rows that a journey seeded, in one spec —
   risk-findings, nudges, stuck-sagas, dead-letters. Assert a seeded value
   appears, not that the table exists.
4. **Matching rounds lookup** by run id, including the not-found path.
5. **Settings round trip** — write the document and sheet slots through the
   form, assert `integration_bindings`, reload, assert it renders back.
6. **403 across tenants** — a session in org A against org B's URL.

What this tier must *not* do: assert on styling, snapshot the DOM, or test
`lib/` logic that a Vitest test covers in a millisecond. The browser is the
slowest and most brittle place to assert anything, so it should only assert
the things that are true *only* in a browser — that a route is reachable,
that a session cookie survives, that a form submits.

---

## Tier 4 — vendor contracts

The adapters are tested against stubbed transports. That proves the adapter
calls the API correctly. It cannot prove the stub still resembles the API,
and the stub is a snapshot of what Google and Slack did on the day someone
wrote it.

Three mechanisms, in order of cost:

1. **Fixture capture.** During a live run (the `live-tenant-testing.md` flow),
   a transport wrapper writes every request/response pair to
   `tests/fixtures/vendor/<vendor>/<call>.json` with a captured-on date.
   The adapter tests replay those instead of hand-written stubs. A stub then
   stops being an assumption and becomes a dated observation — and "this was
   last confirmed against the real API on 2026-03-14" is a fact a reviewer
   can act on. Cheap, and it makes every existing adapter test stronger.
2. **A live checklist with a sign-off table**, in this repo, per adapter call,
   with the date it last passed. The status table in `CLAUDE.md` already
   carries this information in prose; a table makes staleness visible.
   Currently unverified against a live account and therefore top of the list:
   `GoogleSheetsAdapter` (every call), `GoogleDriveDocumentAdapter.isEchoRevision`
   (does `revisions.list` really report `lastModifyingUser.me`?), and the
   Slack `im:history`/`mpim:history` scopes and `message.im`/`message.mpim`
   subscriptions — declared in the manifest, never exercised.
3. **Contract tests against a live sandbox**, on demand, never in the PR gate.
   They need credentials, they mutate real state, and a red build caused by
   an expired Google refresh token teaches a team to ignore red builds.

The plus-addressing finding already in `live-tenant-testing.md` — Drive's
`permissions.create` returns `400 invalidSharingRequest` for `name+role@domain`
while the bare address succeeds — is exactly what tier 4 is for, and it was
found by hand. A captured fixture would have made it a checked-in fact rather
than a paragraph.

---

## Tier 5 — evals, and why they are not in the gate

`session-intel` has 10 golden cases. That is the seed of an eval suite, not a
test suite, and the distinction matters: a test asserts a fixed answer, an
eval measures a rate against labels.

The labels already exist and nothing harvests them. Invariant 19 makes every
human Confirm/Edit click an eval label, and `createPrimitiveSessionIntel`
already stamps the extraction id onto `ai_runs` so the verdict lands on the
run. So:

- `pnpm eval` — separate command, separate exit criteria, reads `ai_runs` with
  verdicts plus the golden set. Reports accuracy, evidence-span validity
  (invariant 18: does every span actually index into the unedited source?),
  and safeguarding recall/precision against a hand-labelled set.
- **Never in the PR gate.** It costs money, it is nondeterministic, and a
  prompt change that moves accuracy from 0.91 to 0.89 is a conversation, not
  a build failure.
- Nightly at most, and the number that matters is the trend across
  `prompt_version` (invariant 20) — which is the entire reason the version is
  stamped, and is unanswerable without this.

One eval-shaped thing *does* belong in the gate, because it is deterministic:
the guarantee that `runPrimitive` never throws because the model failed.
Refusal, timeout, and a schema violation surviving one repair must all reach
`fallback`. That is already tested in `packages/ai`; a journey with a
deliberately hostile `LlmProvider` proves it end to end.

---

## CI — the gate

No CI workflow exists in this repository. Three separate things in the status
table say "not yet wired into CI, since no CI workflow exists" — `deps:check`,
the matching invariants suite, the RLS leak test. Everything above is
hypothetical until this file exists, so it is the first thing to build, before
a single journey.

`.github/workflows/ci.yml`, with a `pgvector/pgvector:pg17` service:

**On every PR** — target under three minutes:

```
pnpm typecheck
pnpm deps:check                     # invariants 1 and 2, currently unenforced
pnpm db:migrate                     # migrations apply from scratch
pnpm test                           # 827, with DATABASE_URL set
pnpm test:e2e                       # tier 2 journeys + P1, P3, P4, P5
pnpm --filter @mentorship/web build
```

**Nightly** — P2 crash-resume across every journey, the full Playwright suite,
`pnpm eval`, and a `pnpm demo` smoke run.

**On demand, manually triggered, credentials from secrets** — the live vendor
contract tests and fixture capture.

Two gate rules worth writing down now rather than discovering later:

- **The PR gate contains nothing nondeterministic.** No model, no network to a
  vendor, no wall-clock sleep. If a test in the gate can fail twice out of a
  hundred for reasons unrelated to the diff, it belongs in nightly.
- **A skipped test is a failure in CI.** `DATABASE_URL` being unset locally is
  a convenience (`describe.skipIf`), and it is the correct default for `pnpm
  test` on a laptop. In CI it would silently drop 95 tests including the
  cross-tenant leak test. The workflow sets `DATABASE_URL` and asserts the
  skipped count is zero.

---

## What none of this can prove

Worth stating, so the suite's green is read correctly:

- **Vendor behaviour.** Tier 4 narrows the gap and dates it. It does not close
  it. A fixture captured in March does not know about an API change in June.
- **DST and real timezones.** `tzOffsetMinutes` is a fixed offset, not an IANA
  zone — a known, flagged simplification. Do **not** write DST journeys until
  that changes: a passing test would be encoding the simplification as
  intended behaviour, which is strictly worse than the current honest comment
  in `core/time.ts`. The journey to write today is
  `no-mutual-availability`, which tests what the code actually claims.
- **Model quality.** Evals measure it; they do not guarantee it, and a journey
  that asserts a specific extraction is a test of the fallback, not the model.
- **Email.** There is no email infrastructure. Magic links print to stdout and
  the digest computes-and-persists rather than sending. A journey can assert
  the token was issued and the digest event was written; nothing here can
  assert a human received anything.
- **Whether the messages are any good.** A pilot proves that. No suite does.

---

## What the journey suite found

Built as specified, with these departures and additions:

- **The harness lives in `tests/e2e/harness/`** (`stage.ts`, `seed.ts`,
  `observe.ts`, `properties.ts`, `crash.ts`), not one file, and `tests/e2e/`
  is a directory on the root `tsconfig`/aliases rather than a workspace
  package — it needs no dependencies of its own. `apps/api`'s Postgres wiring
  was extracted to `buildPostgresApiDeps` (`apps/api/src/postgres-deps.ts`),
  so the server a journey talks to is the one `main.ts` ships.
- **Two processes means two pools.** The API and the worker each get their own
  connection pool and both run as `mentorship_app`, so RLS is enforced on every
  journey rather than bypassed by the superuser.
- **The clock ticks.** One millisecond per read. A frozen clock stamps every
  event in a drain with the same instant, and the relay's `ORDER BY
  occurred_at` then returns ties in heap order — an ordering production never
  has.
- **A third surface: process logs.** "Warns loudly" (invariant 16) and "the
  refusal is visible to an operator" are only observable there.
- **P4 reads `saga_instances.history` and nothing else**, because no
  participant-visible surface can witness a wait with no deadline. The engine
  now records each step's `waitFor`/`timeoutAt`/`done` in its history entry;
  before, only the *current* state's wait was knowable at all. P4 also flags a
  `running` row with no timeout.
- **P5's model fence** is an `LlmProvider` that refuses any question except
  session intelligence, plus a trace check that `run_extraction` is only ever
  emitted on the transition into `extracting`.
- **P2 kills the process, not the call.** The Nth adapter call never returns
  and the worker's pool is ended under it, so Postgres rolls back the relay's
  claim. A thrown error would be caught by the relay and recorded as an
  attempt — a much kinder failure than a process that stops. It runs twice per
  call (before the vendor acts, and after), plus once with a fresh worker
  before every pass. Its comparison is a multiset with ids and sub-minute time
  scrubbed, repeated reads (`transcript.fetch`) excluded, and repeated
  `pair.thread_bound` collapsed (a fresh process re-announces by design).
- **Skipped, with the reason in the file**: `declined` (no Decline button
  exists and the parser rejects the kind), `consent-revoked` (nothing writes
  `consents.revoked_at`), `calendar-never-confirmed` (the runner emits
  `session.scheduled` inside the same effect as `createEvent`; only losing an
  outbox row reaches the timeout). Variants added: `transcribed`,
  `transcription-without-consent`, `document-echo`.

### Product bugs, none fixed here

Each is asserted as the *correct* behaviour and marked `it.fails`, so the day
one is fixed the suite goes red until the marker is removed.

| # | Found by | Bug |
| --- | --- | --- |
| 1 | `one-sided` | A one-sided silence is escalated on the first timeout with **no renudge** — the `partial_response` branch runs before the renudge check (invariant 11). |
| 2 | P1 on every journey that ends paused | A redelivered `pair.activated` **restarts a paused saga**: `SagaEngine.start()` dedupes only against a `running` instance, and a paused one is `done`. The pair a human was asked to look at gets a fresh proposal. |
| 3 | `extraction-timeout` | The confirming-timeout render **replaces the write-up** with the "unverified" banner — the managed region ends up containing only the banner (invariant 19 says mark, not erase). |
| 4 | `dm-outage` | A *failing* (not absent) DM slot **wedges the lifecycle** at the reminder: the step never saves, the timer re-fires and re-throws forever. And `SagaEngine.tick()` has no per-instance failure handling, so that one instance makes **every pass for the org throw**, skipping every other due timer — the same shape as the `findDue` bug, one level down. |
| 5 | P2 | **Stranded at start**: `SagaEngine.start()` commits the instance before its first step runs. A crash in that step leaves it `running` in `idle` with no wait and no timeout; the redelivered activation finds it "running" and leaves it. The pair is never proposed to. |
| 6 | P2 | **`emit` effects are not idempotent.** The completed-effect ledger is saved only when the whole step saves, and an emit is its own committed write with no key, so a retried step re-emits: duplicate `session.scheduled` (and a phantom `sessions` row), `session.held`, `pair.cadence_deficit`. |
| 7 | P2 | **The confirming timeout eats its own event.** It emits `extraction.confirmed {unverified}` before rendering; after a crash the still-`confirming` saga receives that event as a verdict from nobody, re-arms 120h, and the render and feedback requests never happen. |
| 8 | P2 | **A second shared doc on retry.** A pair's first `render_document` has no doc id, and neither `FakeDocument` nor `GoogleDriveDocumentAdapter` uses the idempotency key when creating — a crash after creation makes a second doc (in Drive, a second access email too). |
| 9 | P2, restart-every-pass | **The transcript lives in worker memory** between the pass that fetches it and the pass that extracts it. A restart in between extracts from an empty string: "no transcript was available" for a transcribed session. |
| 10 | seeding | **Nothing writes `integration_bindings.capabilities`.** `PostgresSagaResolvers.capabilities()` reads only that cache (ADR-0006), so a real Postgres tenant sees every slot as `null`: proposals always degrade, and a transcript is never polled for. The harness seeds the probe result, standing in for the connect flow that does not exist. |

Gaps noted rather than tested: there is no Postgres `RosterSink` (the seed has
the only one), and no inbound route writes `feedback.submitted`, so every
journey leaves `feedback` by its window closing.

---

## Build order

Ordered by bugs-caught per hour, not by tier number:

1. **`.github/workflows/ci.yml`** with the PR gate above, running the existing
   827 plus `deps:check`. Nothing new to write; it makes three already-built
   guards actually guard something.
2. (done) **`tests/e2e/stage.ts`** plus the `happy-path` journey. One file of harness,
   one journey. This is the first test in the repo that runs two processes.
3. (done) **P4 and P5** — timeout totality and determinism. Pure observation, no
   per-journey code, and P4 gives invariant 7 its first test.
4. (done) **P3 · tenant isolation**, and with it the second journey. This is the one
   that would have caught `findDue`.
5. (done) **The rest of the catalogue**, cheapest first (three skipped, with reasons). The pause-reason journeys
   (`one-sided`, `no-response`, `declined`, `counter-then-cap`) are mostly
   `script` variations and land in an hour each.
6. (done) **P1 · idempotency replay**, then **P2 · crash resume** wired into nightly
   (`pnpm test:e2e:nightly`; the workflow file in step 1 still does not exist).
7. **Tier 4 fixture capture**, during the next live run, starting with the
   three unverified adapters named above.
8. **Tier 3 Playwright**, six specs.
9. **`pnpm eval`**, once there are enough Confirm/Edit verdicts in `ai_runs`
   for the number to mean anything.

Steps 1 and 2 are most of the value. Everything from 3 onward is leverage on
the harness step 2 builds.

---

## One thing to fix along the way — done

`apps/api/src/main.ts` used to say, on its Postgres path, that "the relay is
not built yet". The relay is built — `relayOnce`, run by `createWorker`. What
is true is narrower, and is what the comment now says: `pnpm serve:api` runs no
relay itself, so a click advances a saga only while `pnpm serve:worker` drains
the same database. Every journey in `tests/e2e/` is that statement, executed.
