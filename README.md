# Mentorship kernel

A multi-tenant core for running mentor–mentee programs, built so other teams
can fork it and run their own program on their own tooling.

Four AI primitives — matching, nudging, session intelligence, progress & risk —
as swappable contracts rather than features. Durable sagas for the flows that
span days and wait on two humans. Every external tool bound through a
configured integration profile.

This repository currently contains the **kernel and the session lifecycle**.
The status of each piece is marked below.

```bash
pnpm install
pnpm test      # 102 tests, ~2s, no database and no model
pnpm demo      # full walk-through printed as a readable trace
pnpm serve:api # the Slack interaction endpoint, live, seeded against testkit
pnpm typecheck

# 48 more tests that need a database, skipped above rather than failing
docker compose up -d db && pnpm db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mentorship pnpm test
```

`pnpm demo` imports a roster of existing pairs, drives one pair through a
complete session cycle — propose, agree, book, remind, transcribe, extract,
project to a shared doc, confirm, collect feedback — and then shows the loop
closing a fortnight later. It touches no database, no network and no model.

## Start here

| If you are… | Read |
| --- | --- |
| A coding agent, or about to change something | [CLAUDE.md](./CLAUDE.md) — the invariants are the part that matters |
| Wondering why it is built this way | [docs/decisions/](./docs/decisions/) — one ADR per decision that could have gone the other way |
| Looking for what is next | [docs/ROADMAP.md](./docs/ROADMAP.md) |
| Getting it onto your machine and into GitHub | [PUSH-TO-GITHUB.md](./PUSH-TO-GITHUB.md) |

---

## The one idea everything else follows from

Most "generic" mentorship platforms stop being generic within a month, and it
is almost always the same mistake: **program policy gets compiled into the
schema and the code paths.** Somebody hardcodes that a mentee has one mentor,
that a session happens fortnightly, that a goal has a due date. The next
organisation runs group mentoring on a six-week sprint, and the fork begins.

So there are four layers, and the boundary between them is the whole design:

| Layer | What lives here | Forker touches it? |
| --- | --- | --- |
| **Kernel** | Identity, tenancy, entities, state machines, the event log, the job runtime | No. If they must, that is a bug in the kernel. |
| **Orchestration** | Durable sagas — the long-running flows people call "agents" | They register a variant, or fork one saga. Never the engine. |
| **Primitives** | The AI capabilities, each a typed contract with a default provider | They swap a provider or add a scorer. |
| **Program policy** | Roles, profile fields, cadence, goal shape, nudge ladder, score weights, integration bindings | This is **data**. Edited at runtime. |
| **Surfaces** | Web app, Slack, Teams, email, API, webhooks | Freely. One adapter per destination. |

The connective tissue is an append-only **domain event log**. Primitives never
sit in a request path; they subscribe to events, and their outputs pass through
a policy gate before reaching a human. That buys three things at once:
primitives become independently testable, a slow or failed model call can never
break a page load, and every AI action leaves a durable before-and-after record.

---

## Pairing is optional

Matching is a capability, not a prerequisite. The most common real starting
point is an admin with a spreadsheet of pairs that already exist — decided in a
meeting, inherited from last year, or matched by hand.

```
programs.policy.pairing.mode = "imported" | "manual" | "matched" | "self_select" | "hybrid"
```

Imported rows emit exactly the `pair.activated` event that the matching
primitive would, so everything downstream — the session saga, reminders,
extraction, health scoring — is identical and **cannot tell the difference**.
`pairings.origin` records where a pair came from, for reporting only.

The importer is always plan-then-commit. A roster import that writes on upload
is how an organisation ends up with forty duplicate pairs and no way back.

```ts
const plan = planRosterImport(csv, { policy, existing, defaultTzOffsetMinutes: 330 });
console.log(renderPlan(plan));       // show the admin the diff
if (planIsCommittable(plan)) {
  await commitRosterImport(plan, sink, { importedPairsStart: "active" });
}
```

It handles what real spreadsheets actually contain: header aliases
(`Mentor Email` / `mentor_email` / `Mentor E-Mail`), quoted fields, tabs, a
UTF-8 BOM, cadence written as `biweekly` or `21d` or `as needed`, timezone
offsets as `+05:30` or `5.5`. It reports **errors** (self-pairing, unreadable
email, uninterpretable cadence) separately from **warnings** (mentor over
capacity, missing verified chat id, no timezone) separately from **skips**
(already exists, duplicated in this file). Re-uploading last week's sheet with
three new rows at the bottom is the normal case, not an error.

---

## Agents are durable sagas

A primitive answers one question in one pass. A planner that proposes a time,
waits for two humans to reply in a thread, handles one agreeing while the other
counters, handles silence for three days, and only then books a calendar invite
is a **long-running workflow with waits, timeouts and compensation** — and it
has to survive a deploy.

```ts
interface Saga<S> {
  name: string;
  step(state: S, input: SagaInput, ctx: SagaContext): Promise<{
    next: S;
    waitFor?: EventPattern;   // advance when this event arrives…
    timeoutAt?: string;       // …or when this timer fires, whichever first
    effects: Effect[];        // idempotent, keyed saga:{id}:{step}:{index}
    done?: boolean;
  }>;
}
```

`SessionLifecycle` is one instance per active pair, looping for the life of the
cohort:

```
proposing → scheduling → armed → awaiting_artifact → extracting
          → confirming → feedback → cooling ─┐
              ▲                              │
              └──────────────────────────────┘
                   agreed frequency elapses
```

"Check a week later whether the next meeting is set up" is not a separate job.
It is `cooling` expiring.

Four rules hold throughout, and each one is a test in
`packages/workflows/src/__tests__`:

- **Effects are idempotent by key.** A retried step that posts a duplicate
  message is annoying; one that books a second calendar invite ends the pilot.
  Belt and braces: the engine keeps a completed-effect ledger *and* passes the
  key to the adapter.
- **Sagas read through resolvers and mutate only through effects.** Anything
  the saga needs back arrives as an event, never as a return value. That is
  what makes every effect safely retryable.
- **Only two states are model-driven** — `proposing` drafts the message and
  picks which slots to offer, `extracting` runs session intelligence.
  Everything else is a deterministic transition with an explicit timeout, which
  is why the whole flow tests in milliseconds.
- **Every transition appends to history.** The question you will actually need
  answered is "why is this pair stuck in `confirming`?"

### "If they agree" has five outcomes, not two

`agreements` is a real table with a real resolver. Both accept the same option;
both accept *different* options (conflict — re-propose the intersection, never
silently pick one); one counters (new round, capped at two, then a human); one
declines; one replies and the other never does (`require_both` by default, or
`proceed_on_one` for programs that would rather over-schedule than stall);
nobody replies (renudge once, then escalate — never a third attempt).

The bookkeeping is entirely deterministic. An inferred "I think they agreed",
parsed out of free text, will eventually book a meeting nobody consented to.

---

## Integration profile

Eight slots, bound per program. Running on Teams instead of Slack, or writing
the notes to Notion instead of Google Docs, is configuration — not a fork.

| Slot | Purpose | If the slot is empty |
| --- | --- | --- |
| `conversation` | Joint pair thread, proposals, agreement buttons | In-app thread plus an email digest |
| `dm` | Reminders and feedback, privately | Email |
| `calendar` | Free/busy, invite create and update | Propose times from stated availability; the pair books it |
| `conferencing` | Meeting link, recording flags | Link only; skip the transcript path |
| `transcript` | Fetch the artifact after the call | Ask both parties for notes |
| `document` | Canonical shared write-up | Internal page at a stable URL |
| `sheet` | Tabular export for reporting | Dashboard only |
| `dashboard` | Exec read surface, scheduled digest | API only |

Adapters **declare** what they can do and the saga **negotiates**:

```ts
interface AdapterCapabilities {
  threadedConversation: boolean;
  interactiveApproval: boolean;          // buttons — never parse "yes" from prose
  freeBusy: boolean;
  createEventWithConference: boolean;
  autoTranscription: "native" | "byo" | "none";
  anchoredDocEdits: boolean;
  identityMapping: "verified" | "email_guess";
}
```

Capabilities are **probed once per tenant and cached on the binding**, not
inferred from the vendor's name. Whether a given organisation actually gets an
automatic meeting transcript depends on its subscription edition, its admin's
policy settings and sometimes the organiser's individual licence. Getting this
wrong optimistically means the saga waits for a transcript that will never
arrive, so the default is pessimistic and **the manual-notes path is a
first-class flow, not an error state**.

Degradation lives in the effect runner, not in the saga. One exception, on
purpose: a private message never falls back to the joint thread. A feedback
request that lands in front of the other participant is worse than one that is
not sent.

---

## The shared document is a projection, not the source of truth

The database is the source of truth. The shared doc carries a marker-delimited
managed region that the platform re-renders; everything outside the markers
belongs to the pair and is never touched.

Changes are collected **in the conversation thread, not by parsing doc edits** —
a threaded reply maps cleanly onto a structured field, whereas a rewritten
paragraph does not, and guessing wrong there silently corrupts action items.

Three details keep it stable: **echo suppression** (ignore revisions authored by
your own service account, or a render triggers a change which triggers a
render), **pinning** (a human edit inside the managed region becomes an override
and that block stops being re-rendered), and **unverified marking** (an
auto-confirmed extraction is labelled as such — a timeout must never silently
promote a machine guess to agreed fact).

---

## Consent and hard limits

Mentoring conversations are confidential by convention, and participants assume
that convention holds whether or not it is implemented. A platform that quietly
routes those conversations to an admin dashboard destroys the thing it is
trying to support — and people simply stop writing notes, which silently kills
three of the four primitives.

- **Recording consent is tracked separately from AI-processing consent.** Two
  different acts with different exposure. Off by default, both parties
  required, revocable — and revoking it changes *future invites*, not just what
  gets extracted. All-party consent to record is legally required in some
  jurisdictions; this is one to route past counsel rather than infer from the
  product's defaults.
- **Individual feedback scores are never attributed to a named person outside
  the pair**, at any level of the org chart, for any reason. Activity is
  attributable; sentiment is not. The moment a mentee believes their rating of a
  mentor reaches a VP with both names on it, you will receive only fives.
- **AI never ends a pairing**, and never sends a judgement about a person to
  that person's manager.
- **No output of this system is designed for performance management.** Refuse to
  build the export that enables it.
- **Notes are untrusted input.** A mentee can paste anything into a note,
  including text shaped like instructions. Extracted content is never
  concatenated into a later prompt as instruction, and never authorises a tool
  call or a send.
- `safeguarding` **bypasses everything** — no queue, no batching, no nudge. It
  reaches a named human out of band. Decide who that human is before shipping
  the flag.

---

## Layout

```
packages/
  core/          entities, zod schemas, state machines, event + saga + adapter types
                   ZERO dependencies on db, llm, http. Everything imports this.
  db/            drizzle schema, RLS policies, withTenant()
  events/        append-only log, outbox relay, dead letters
  workflows/     saga engine, SessionLifecycle, effect runner
  integrations/  slot registry, capability negotiation, adapters
  roster/        spreadsheet import — plan, validate, commit
  testkit/       in-memory world, so the whole thing runs without Postgres
apps/
  worker/        the demo; in production, the event consumer and job runner
examples/
  roster-pairs.csv
```

Dependency rule, worth enforcing in CI with `dependency-cruiser`:

```
primitives   → core, ai                        never → api, web, db
workflows    → core, primitives, integrations  never → web
integrations → core only                       never → primitives, workflows
db           imported only by api, jobs, workflows
```

### Status

| Piece | State |
| --- | --- |
| Core contracts, policy schema, agreement resolver, interval maths | **Working, tested** |
| Saga engine — idempotent effects, optimistic concurrency, timers, history | **Working, tested** |
| `SessionLifecycle` — all deterministic states | **Working, tested** |
| Roster import — parse, plan, validate, commit | **Working, tested** |
| Integration registry, capability negotiation, degradation | **Working, tested** |
| Fake adapters (chat, dm, calendar, transcript, document) | **Working** — used by tests and the demo |
| Postgres schema, RLS policies, `withTenant` | **Working, tested** — migrations applied, and a cross-tenant leak test proves the policy bites rather than assuming it |
| Outbox relay (`relayOnce` / `relayLoop`) | **Working, tested** — claim with `SKIP LOCKED`, at-least-once, backoff and dead-lettering |
| `PostgresSagaResolvers`, `PostgresEventSink`, `PostgresProjector` | **Working, tested** — the counterparts to testkit's `World`, projections included |
| `createWorker` (`apps/worker`) | **Working, tested end to end** — a `pair.activated` row becomes a proposed, agreed and booked session on Postgres. Nothing schedules it yet |
| `PostgresSagaStore` | **Working, tested** — round-trip, optimistic concurrency under a real race, and parity with the in-memory store |
| Slack interaction endpoint, mounted behind `apps/api` (`node:http`) | **Working, tested** over a real socket with a genuine HMAC signature and the actual saga. Runs on Postgres when DATABASE_URL is set (verified identity links, response and outbox event in one transaction) or on the in-memory world without one. **No relay drains the outbox yet**, so on Postgres the click is recorded and the saga does not move; "suggest another" acks but does not open a modal (ADR-0004's open gap) |
| Slack conversation and Google Calendar adapters | **API shapes written, never run against a live tenant** |
| Session intelligence | **Deterministic stub** — `heuristicSessionIntel`, cue-phrase based. The seam is `SessionIntel`. |
| Matching, nudge planner, progress & risk | **Not started** — contracts defined in `core` |
| Web app, API, auth, dashboards | **Not started** |

---

## Postgres

Only Postgres: pgvector for embeddings, pg-boss for the job queue, RLS for
tenancy. `docker compose up` has to work for a self-hoster, and every managed
service added here is an adopter lost.

```bash
docker compose up -d
pnpm db:generate                                   # structural migration
psql "$DATABASE_URL" -f packages/db/migrations/0002_rls.sql
```

Every table carries `org_id` and a row-level security policy reading
`app.current_org`, so a query that forgets its `WHERE` clause returns zero rows
rather than another organisation's data. Verify the policy actually bites before
trusting it — the check is at the bottom of `0002_rls.sql`.

---

## Traps this design is shaped around

| Trap | What it costs |
| --- | --- |
| Tenancy added later | The most expensive migration in this shape. `org_id` + RLS from migration one. |
| Greedy matching | Mentee forty gets nobody while mentors sit under capacity. Solve it as capacity-aware global assignment. |
| "Tuesday 3pm" availability | Silently wrong overlaps across timezones and DST, which look like matching bugs for months. UTC interval sets. |
| No absence detector | Reminders only fire when something happens, which is backwards. Half of what matters is an absence. |
| Notification fatigue | People mute you and there is no second chance at a channel. Dedupe keys and rate limits from the first send. |
| Non-idempotent saga effects | Double-booked meetings. Key every effect. |
| Identity mapping by email guess | Eventually puts the wrong person in a private pair thread. Explicit table, verified at enrolment. |
| Doc render loop | Your render triggers a change which triggers a render. Suppress your own service account's revisions. |
| Assuming transcription exists | The saga waits forever for an artifact the tenant was never entitled to. Probe and cache. |
| Agreement with no timeout or round cap | Sagas stuck forever, or a negotiation both parties mute. Two rounds, then a human. |
| Feedback in the joint thread | You get fives and learn nothing. |
| Model-generated health scores | Indefensible the first time an admin asks why a pair is amber. Deterministic composite from signals; the model explains. |
| Prompts inline in code | You cannot tell whether last week's change helped. Prompt registry + `ai_runs` from the first call. |
| No eval harness in the repo | Nobody can safely change a prompt, so nobody contributes. |

---

## Known simplifications

Called out because they are the things that will bite, not because they are
hidden:

- **Timezones are fixed offsets in minutes**, not IANA zones. Correct for a
  scaffold and wrong twice a year. Replace `tzOffsetMinutes` with a zone id
  resolved per instant before this touches a cohort spanning a DST boundary.
- **The saga store and event log are in-memory** in `testkit`. The Postgres
  translations are a thin mapping of the same six store methods, where `save`
  becomes `UPDATE … WHERE version = $expected`.
- **`heuristicSessionIntel` is not extraction.** It finds cue phrases. It exists
  so the document projection, the confirm step and the tests are exercised end
  to end without a model. A real implementation keeps the evidence spans — they
  are what make an extracted claim checkable rather than believable.
- **No authorisation layer yet.** The data-visibility matrix belongs in policy
  and needs tests before any real participant data goes near it.

## Licence

Apache-2.0
