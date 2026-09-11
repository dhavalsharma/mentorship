# ADR-0003: Pairing is an optional mode; import emits the same event as matching

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

Matching was designed first and assumed to be the entry point: profiles in,
proposals out, admin approves, pairs exist.

That assumption is wrong for a large share of real programs. Many
organisations arrive already knowing who is paired with whom — decided in a
meeting, inherited from last year, matched by hand by someone who knows the
people. They want reminders, session write-ups and reporting. They do not want
to be re-matched, and a platform that insists on it is a platform they do not
adopt.

There is also a bootstrapping problem: matching quality depends on profile
depth that does not exist on day one. A program whose first act is a
mediocre automated match has spent its credibility before delivering anything.

## Decision

`policy.pairing.mode` selects `imported` | `manual` | `matched` |
`self_select` | `hybrid`. In three of the five, the matching primitive never
runs.

The mechanism that keeps this from being a special case: **an imported pair
emits exactly the `pair.activated` event the matching primitive would.** The
session saga, reminders, extraction and health scoring are identical and cannot
distinguish the two. `pairings.origin` records provenance for reporting and is
never branched on.

Roster import is plan-then-commit: parse, validate, show the admin a diff,
then write.

## Options Considered

### Option A: Pairing mode, one activation event (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — an enum plus an importer |
| Cost | Low |
| Adoption | High — an org can be live in an afternoon |
| Team familiarity | High |

**Pros:** Also doubles as a test of the kernel boundary: if a cohort can be
paired from a spreadsheet and nothing downstream notices, the layering is real
rather than aspirational. Removes matching from the critical path, so it can
ship in phase 3 when there is data to make it good.

**Cons:** Two code paths that create pairings, both of which must maintain the
same invariants (state machine, capacity, dedupe). Imported pairs have thin
profiles, so later matching or health scoring has less to work with.

### Option B: Matching is mandatory; importing means pre-seeding profiles and forcing a match

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — a "pinned pair" concept inside the solver |
| Cost | Low |
| Adoption | Poor |
| Team familiarity | High |

**Pros:** One pairing path. The matcher stays the single authority.

**Cons:** Makes the common case go through the complicated machinery. An admin
who already knows the pairs has to express them as constraints on a solver,
which is both confusing and fragile. Also demands profile data that does not
exist yet.

### Option C: A separate "lite" product for pre-paired programs

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — two products |
| Cost | High |
| Adoption | Good initially, bad at upgrade time |
| Team familiarity | High |

**Pros:** Each product is simple.

**Cons:** The upgrade path from lite to full is a migration, which is exactly
where customers churn. And it is two things to maintain to avoid one enum.

## Trade-off Analysis

A versus B is about which case gets to be simple. B optimises for conceptual
purity (one authority for pairing); A optimises for the path most organisations
actually take. Since matching cannot be good on day one anyway, making it
optional costs nothing and removes the largest adoption barrier.

The cost of A — two creation paths sharing invariants — is real but contained:
both funnel through the same `pairings` state machine and the same activation
event, so the shared surface is small and testable. The test suite asserts that
an imported pair enters the lifecycle identically.

C was never seriously in contention; it trades a one-line enum for a permanent
maintenance and migration burden.

## Consequences

**Easier**
- Time to first value: upload a sheet, the saga starts, reminders flow.
- Building matching later, against real profile data, without blocking anything.
- Demonstrating the architecture: the demo pairs from a CSV and the rest of the
  system is unaware.

**Harder**
- Two paths create pairings; both must respect capacity, dedupe and the state
  machine. Enforced by funnelling both through the same activation event, but
  it needs a test whenever either path changes.
- Imported pairs carry no profile narrative, so `matched` mode later on a
  `hybrid` program works with sparse data. Acceptable — it degrades to
  constraint satisfaction, which is still useful.
- The importer is a surprisingly large surface: header aliases, quoted fields,
  BOMs, cadence and timezone dialects. Worth it — every one of those is a
  support ticket avoided.

**To revisit**
- `hybrid` mode is defined but untested. Before using it, decide what happens
  when a mentor appears in both the imported set and the matchable pool.
- Whether imported pairs should be able to *request* a re-match later.

## Action Items

1. [x] `pairing.mode` in policy; `pairings.origin`
2. [x] Importer: parse, plan, validate, commit, with errors/warnings/skips split
3. [x] Order-independent pair key so re-upload is idempotent
4. [x] Test that an imported pair enters the lifecycle identically
5. [ ] Exercise `hybrid` mode, or remove it until it is needed
6. [ ] Admin UI for the plan diff — the safety of plan-then-commit depends on a
       human actually reading it
