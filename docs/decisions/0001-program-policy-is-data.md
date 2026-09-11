# ADR-0001: Program policy is data, not code

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

The platform has to run mentorship programs for organisations that disagree
about almost everything: how many mentors a mentee has, how often they meet,
what a goal looks like, what a profile contains, who approves a pairing, how
hard to push someone who has gone quiet.

Every "generic" platform in this space that stops being generic does so the
same way. The first customer's assumptions get written into the schema and the
code paths — one mentor per mentee, fortnightly sessions, a goal with a due
date — and the second customer, running group mentoring on a six-week sprint,
gets a fork. Once there are two forks there is no shared roadmap, and the
open-source premise collapses.

Constraint that makes this sharper than usual: the goal is for **other teams to
build on this**. A design that only survives contact with our own first
customer is not good enough.

## Decision

A program's behaviour is a validated JSON document (`programs.policy`,
`ProgramPolicySchema` in `core/policy.ts`) edited at runtime. It covers roles,
pairing mode, cadence, agreement rules, artifact polling, confirmation windows,
feedback, consent, integration bindings and score weights.

No code path branches on a tenant identity. Cadence resolves
program → cohort → pair, so a single pair can differ without a schema change.

## Options Considered

### Option A: Policy as validated data (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — one large schema, defaults everywhere |
| Cost | Low |
| Flexibility | High — new tenant needs no deploy |
| Team familiarity | High — it is just zod |

**Pros:** A new program shape is a form submission. Presets become data files.
The admin UI is the configuration surface. Testing a variant costs one object
literal, which is why the test suite can cover `proceed_on_one` and ad-hoc
cadence without a second codebase.

**Cons:** The schema grows and every field needs a sane default, or old
programs break on deploy. Wide config surfaces are easy to get into states
nobody designed for. Some policy is genuinely behavioural and does not fit in
JSON — see the escape hatch below.

### Option B: Per-tenant code modules

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low at first, high at ten tenants |
| Cost | A deploy per configuration change |
| Flexibility | Total, but only for us |
| Team familiarity | High |

**Pros:** Anything is expressible. No schema to design up front.

**Cons:** Configuration requires an engineer, which caps how many programs can
run. Tenants cannot self-serve. It is indistinguishable from maintaining N
forks, which is the failure this decision exists to prevent.

### Option C: A plugin/hook system with arbitrary code per tenant

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — sandboxing, versioning, a plugin API to keep stable |
| Cost | High |
| Flexibility | Very high |
| Team familiarity | Low |

**Pros:** Covers policy that data cannot express.

**Cons:** Enormous up-front cost for flexibility nobody has asked for yet, and
a plugin API is a far harder contract to keep stable than a schema. Premature.

## Trade-off Analysis

A and B trade *who* can configure a program against *how much* can be
configured. B expresses more but requires us for every change; A expresses less
but lets a program admin do it at 11pm without us.

The deciding factor is the open-source goal. A forker evaluating this repo asks
"can I run *my* program on it?" — and the honest answer has to be yes without
editing `core`. That is only true under A.

C would resolve the expressiveness gap, but the gap is not yet real: nothing in
the four planned primitives needs per-tenant code. Deferred, not rejected.

The escape hatch that makes A sufficient: policy selects a **saga by name**, so
a program needing a genuinely different session flow gets a registered saga
variant rather than a new config field. Behaviour is pluggable at the saga
level; parameters are data.

## Consequences

**Easier**
- Onboarding a new program: no deploy, no engineer.
- Shipping presets (university, corporate career, founder network) as proof of
  genericity — they are data files plus a scorer or two.
- Testing variants: one object literal per scenario.

**Harder**
- Every new field needs a default that keeps existing programs working.
- The config surface needs validation *and* a UI that makes invalid states hard
  to reach. Schema validity is not the same as a sensible program.
- Debugging "why did it do that?" now means reading the tenant's policy as well
  as the code. Mitigated by recording the resolved policy on `ai_runs` and in
  the saga history.

**To revisit**
- If two tenants need behaviour that no schema field can express and a saga
  variant cannot cover, reopen Option C.
- If the schema passes ~50 fields, split it per concern rather than letting one
  object accumulate.

## Action Items

1. [x] `ProgramPolicySchema` with defaults on every field
2. [x] Cadence resolution: program → cohort → pair
3. [ ] Admin UI that constrains rather than exposes raw JSON
4. [ ] Ship two or three presets — the real test of the claim
5. [ ] Record the resolved policy version on `ai_runs` and saga history
