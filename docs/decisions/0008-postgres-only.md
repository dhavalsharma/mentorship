# ADR-0008: Postgres only — pgvector, pg-boss, RLS

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

The system needs a relational store, a job queue with scheduled and delayed
work, vector similarity for profile narratives, and multi-tenant isolation.

There are better individual tools for each of those. The question is what the
combination costs an adopter, because this repository is meant to be forked and
self-hosted. The first thing a person evaluating it does is try to run it. If
that means provisioning a queue, a vector database and a managed workflow
service before the tests pass, most of them stop there — and a project nobody
can run is not an open-source project.

Tenant isolation has its own consideration: with `org_id` on every table,
isolation depends on every query being scoped correctly, forever, by everyone
who ever contributes. That is a bet on discipline, and discipline loses.

## Decision

Postgres for everything:

- **pgvector** for embeddings (only two things need them: profile narratives
  and topic-taxonomy mapping)
- **pg-boss** for queues, schedules and delayed jobs
- **Row-level security** for tenancy, with policies reading
  `app.current_org`, set per transaction by `withTenant`
- `saga_instances` as a table, advanced by an event or a timer

`docker compose up` brings up one container. The app connects as a role that is
neither the table owner nor `BYPASSRLS`, so a query that forgets its `WHERE`
returns zero rows instead of another organisation's data.

## Options Considered

### Option A: Postgres only (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low operationally, some SQL sophistication needed |
| Cost | One database |
| Scalability | Good to a point — one store becomes the bottleneck eventually |
| Team familiarity | High |

**Pros:** One thing to run, back up, monitor and reason about. Transactional
outbox is trivial because the event write and the state change share a
transaction. RLS makes isolation a database guarantee rather than a code
convention. A contributor is productive in one command.

**Cons:** Every workload competes for the same instance — queue polling,
vector search and transactional reads on one box. pgvector is good and not
best-in-class at scale. pg-boss lacks the observability of a dedicated queue.
RLS is easy to misconfigure and the misconfiguration is silent.

### Option B: Best tool per concern (SQS/Redis, Pinecone/Qdrant, Temporal)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High operationally |
| Cost | Several services, mostly managed |
| Scalability | Excellent |
| Team familiarity | Medium |

**Pros:** Each component is better. Independent scaling. Better observability.
This is the right answer for a large single-tenant deployment.

**Cons:** The quickstart becomes a page of provisioning. It effectively rules
out self-hosting for small teams, which is most of the audience for a forkable
kernel. It also couples the project to vendor availability in a way an
Apache-licensed repo should avoid.

### Option C: Postgres now, abstract behind ports for later

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — ports and two implementations |
| Cost | One database now |
| Scalability | Good — swap without rewriting |
| Team familiarity | High |

**Pros:** Keeps the one-command quickstart and leaves the door open.

**Cons:** Premature abstraction where the port is guessed rather than driven by
a second implementation.

## Trade-off Analysis

A versus B is entirely about who the deployment is for. For a single large
customer, B. For a project meant to be forked, A — the quickstart is a feature,
and arguably the most important one for adoption.

C is what was actually built, without calling it that. The ports that exist are
the ones with a real second implementation today: `SagaStore` has an in-memory
version used by every test, and the integration slots have fakes. Those were
not written for future flexibility; they were written because the tests needed
them, and they happen to also be the seams a large deployment would swap. That
is the right order — the abstraction earned its place before it was needed for
scale.

No port was invented for the queue or the vector store, because there is no
second implementation and no evidence of what it would need.

## Consequences

**Easier**
- `docker compose up` and the tests pass.
- Transactional outbox: event and state change in one transaction, no
  distributed commit.
- Isolation as a database guarantee, not a convention.
- One backup, one restore, one thing to monitor.

**Harder**
- Workloads contend. Queue polling and vector search on the transactional
  instance will need attention before it matters.
- RLS misconfiguration is silent and looks like "no data" rather than an error.
  This is why `0002_rls.sql` ends with a verification query — **run it, do not
  assume the policy bites.**
- `withoutTenantIsolation` exists for migrations and the outbox relay, and is
  named to be conspicuous in review. Every use is a potential leak.
- pg-boss gives less operational insight than a dedicated queue.

**To revisit**
- When queue throughput or vector search measurably affects transactional
  latency, move that workload first — queue is the easier extraction.
- If a deployment needs physical tenant separation for procurement reasons,
  schema-per-tenant is a deployment change rather than a rewrite, because all
  access already routes through `withTenant`.
- Swap `SagaStore` for Temporal if saga volume demands it (ADR-0002).

## Action Items

1. [x] Drizzle schema with `org_id` on every tenant table
2. [x] RLS policy migration with a verification query
3. [x] `withTenant` / `withoutTenantIsolation`
4. [x] `SagaStore` port with an in-memory implementation
5. [ ] **Apply the migrations and run the RLS verification.** No migration has
       been applied yet; the policy is untested against a live database.
6. [ ] pg-boss wiring for the saga timer tick
7. [ ] Cross-tenant leak test in CI: two orgs, assert zero visibility
