# ADR-0002: Long-running flows are durable sagas, not primitives

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

The product brief described three "agents": a planner that proposes session
times and follows through, a reminder agent, and a reporter.

Examined closely, they are three different things. The **reporter** decides
nothing — it is a read model over `signals` and `events`. The **reminder** is a
step inside a larger flow. Only the **planner** is genuinely an agent, and what
it actually does is:

1. post a proposal to a joint thread
2. wait — possibly for days — for two humans
3. handle one accepting while the other counters
4. handle nobody replying at all
5. book a calendar invite
6. wake up before the meeting
7. wake up after it to look for a transcript, repeatedly, with backoff
8. wake up a fortnight later and start again

That is not a function. It is a process with waits, timeouts, partial failure
and compensation, and it has to survive a deploy, a restart and a three-day
silence.

## Decision

Introduce `packages/workflows`: a durable saga engine with a `saga_instances`
table. A saga's `step()` returns the next state plus **either** an event
pattern to wait for **or** a timer, plus a list of effect descriptors. The
engine executes effects with an idempotency key, persists the transition under
optimistic concurrency, and appends to history.

"Agents" are sagas. "Primitives" are the inference steps sagas call.
"Adapters" are how sagas touch the outside world.

## Options Considered

### Option A: Durable saga engine (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — ~250 lines of engine, one table |
| Cost | Low — Postgres rows and a scheduled tick |
| Scalability | Good — instances are independent, sharded by subject |
| Team familiarity | Medium — the pattern is well known, our engine is ours |

**Pros:** State is a row, so a three-day wait is free and survives anything.
Every transition is inspectable, which answers the 2am question ("why is this
pair stuck in `confirming`?"). The flow is one readable file rather than
scattered across handlers. Testable in milliseconds with a fake clock, which is
how the suite covers renudge-then-escalate without waiting 96 hours.

**Cons:** We own it, including the concurrency semantics. Sagas can get stuck
in a state with no timeout — the engine cannot detect an intended-but-missing
timer. Long-lived state means schema migration of persisted state shapes is a
real problem later.

### Option B: A chain of event handlers with no explicit state machine

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to write, high to understand |
| Cost | Low |
| Scalability | Good |
| Team familiarity | High |

**Pros:** No new abstraction. Each handler is small.

**Cons:** The flow exists only in the developer's head — there is no artefact
that says what happens after a proposal. Timeouts have to be hand-rolled per
handler. "Where is this pair in the process?" becomes a join across tables and
a guess. This is the design that produces the bug where a pair silently stops
receiving proposals and nobody notices for a month.

### Option C: An LLM agent loop with tools

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to prototype, high to operate |
| Cost | High — tokens on every wake-up, for deterministic work |
| Scalability | Poor — non-determinism multiplied by every pair, every fortnight |
| Team familiarity | Medium |

**Pros:** Handles unanticipated situations. Fast to demo.

**Cons:** The steps are almost entirely deterministic — compare a date, check a
flag, send a message. Paying a model to decide them buys nothing and risks a
double booking, which is the one failure that destroys trust in a scheduling
product. It is also close to untestable: you cannot assert "exactly one
reminder was sent" against a model. And an agent holding a three-day wait in
context is either an expensive idle process or a lossy resume.

### Option D: Temporal / Inngest

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low in our code, high in operations |
| Cost | A managed service, or a Temporal cluster to run |
| Scalability | Excellent |
| Team familiarity | Low |

**Pros:** Battle-tested durability, retries, versioning and observability.
Genuinely better than what we wrote, on every axis except one.

**Cons:** That one axis is decisive: `docker compose up` has to work for a
self-hoster (ADR-0008). Adding a Temporal cluster to the quickstart loses
adopters. Our needs are also modest — waits, timers, idempotent effects — and
the `SagaStore` port means swapping the engine later is a contained change.

## Trade-off Analysis

C is the fashionable answer and the wrong one here: the work is deterministic,
and the cost of a wrong decision (a duplicate invite, a missed session) is
borne by two people who then stop trusting the tool. Keep the model where
judgement actually helps — drafting the message, choosing which slots are worth
offering, reading a transcript. Two states out of nine.

B is what this becomes if nobody writes the engine, and its failure mode is
invisible rather than loud.

D versus A is the real decision, and it turns entirely on self-hostability. A
is chosen with the explicit expectation that a large deployment may swap in D
behind `SagaStore` and the saga interface.

## Consequences

**Easier**
- Reading the session flow: one file, one union of states.
- Testing: fake clock, fake adapters, whole lifecycle in milliseconds.
- Debugging: `saga_instances.history` is a transition log per pair.
- Adding a flow: a new saga plus a `starters` entry.

**Harder**
- We own concurrency. `save` is version-checked and conflicts are swallowed in
  favour of the winner, which is correct but subtle.
- A state with no timeout stalls silently. Needs a monitoring query for
  instances that have not advanced in N days.
- Persisted state shapes will need migration once instances are long-lived.
- Effects must be written idempotently by hand. The ledger plus adapter keys
  make this two layers deep, deliberately.

**To revisit**
- If saga volume or complexity grows past comfortable, migrate to Temporal
  behind the existing port.
- Before the first production cohort: the stalled-instance monitor, and a
  versioning strategy for persisted state.

## Action Items

1. [x] Engine: event/timer advance, idempotent effects, optimistic concurrency
2. [x] `SessionLifecycle` covering the whole planner brief
3. [x] Terminal events end an instance from any state
4. [ ] Postgres `SagaStore` implementation
5. [ ] Monitoring: instances not advanced in N days; dead-letter review
6. [ ] State-shape versioning before instances outlive a release
