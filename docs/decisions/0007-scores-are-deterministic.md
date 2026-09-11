# ADR-0007: Scores are deterministic; the model explains them

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

Program admins need to know which mentoring relationships are working and which
are quietly failing, early enough to intervene. The obvious shape is a
"relationship health score" per pair, with an at-risk flag.

The obvious implementation is to give a model the pair's history and ask it to
rate the relationship. That is a mistake, and the reason is a question that
always gets asked: **"why is this pair amber?"**

An unexplainable number about a working relationship between two named people
is worse than no number. Admins stop trusting it, participants who find out
resent it, and nobody can tell whether a change to the scoring made things
better or just different.

There is a second, quieter risk. A per-person score attached to a named
individual drifts toward performance management, whatever the stated intent.
Once it exists, someone will ask to export it.

## Decision

Health is a **weighted composite of observable signals**, computed from the
`signals` table, fully reproducible. Components and default weights:

| Component | Weight | Quality |
| --- | --- | --- |
| Cadence adherence | 0.30 | Strong |
| Action-item completion | 0.20 | Strong |
| Goal velocity | 0.20 | Sparse early |
| Reciprocity | 0.15 | Proxy |
| Survey sentiment | 0.10 | Strong, low volume |
| Response latency | 0.05 | Noisy |

Weights come from program policy. Every score ships with a **confidence derived
from data density** — a pair three days into a cohort has no meaningful score,
and saying so beats a confident wrong one.

At-risk detection is **rules plus trend**, not a classifier: two consecutive
periods of declining cadence adherence, a strained sentiment band with no
session booked, an `ended_early` among a mentor's other pairs.

The model's role is bounded and genuinely useful: turn the component breakdown
into a paragraph an admin can act on, rank interventions, and help a mentee
turn a vague ambition into a structured goal they then edit.

## Options Considered

### Option A: Deterministic composite, model explains (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — SQL over one table |
| Cost | Near zero for the score |
| Explainability | Complete — the breakdown *is* the answer |
| Team familiarity | High |

**Pros:** "Why amber?" answers itself. Changing weights can be replayed against
last cohort's data instead of argued about. Reproducible, so a score can be
recomputed and audited. Tunable per program without code.

**Cons:** Only measures what is instrumented. A pair meeting religiously and
getting nothing out of it scores well — the metrics are proxies for value, not
value. Weights are initially guesses with no outcome data to fit them to.

### Option B: Model scores the relationship from its history

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to build |
| Cost | Per-pair inference on every recompute |
| Explainability | Poor — post-hoc rationalisation |
| Team familiarity | Medium |

**Pros:** Can weigh things no metric captures: tone, whether the mentee sounds
stuck, whether the conversation is going somewhere. Genuinely more perceptive
on the cases that matter.

**Cons:** Not reproducible, so the same pair can score differently on Tuesday.
An explanation generated alongside a score is a rationalisation, not a cause.
Impossible to evaluate against outcomes in a way anyone would trust. And it
requires the model to read private session content in order to produce a number
an admin sees, which cuts against the confidentiality the platform depends on.

### Option C: Hybrid — deterministic score, model-generated adjustment within bounds

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Medium |
| Explainability | Partial — the base is clear, the adjustment is not |
| Team familiarity | Medium |

**Pros:** Keeps a defensible base while letting the model flag what metrics
miss.

**Cons:** The adjustment is the part that will be disputed, so the
explainability problem is not solved, only shrunk. Worth reconsidering as a
separate *flag* rather than an adjustment to the number.

## Trade-off Analysis

B is more perceptive and A is more defensible, and defensibility wins because
of who the audience is. This number is shown to a program admin about two named
employees. It has to survive being questioned.

The right way to capture B's upside without its cost is not C — it is to let
the model produce **flags with evidence** ("the mentee mentioned being stuck
three sessions running, quoted here") that sit *beside* the score rather than
inside it. A flag with a citation is checkable; a nudged number is not. That
keeps the composite reproducible and still surfaces what metrics miss.

A's real weakness stands: the weights are guesses. The mitigation is that
`signals` and the weights are both data, so once there are outcomes — pairs
that completed well versus ended early — the weights can be fitted and the
change replayed over history. That is a better position than B ever reaches,
because B has nothing to fit.

## Consequences

**Easier**
- Answering "why?" — the breakdown is the explanation.
- Recomputing history after a weight change, and comparing.
- Per-program tuning (peer mentoring weights reciprocity higher) as config.
- Keeping the model out of a path where it reads private content to produce an
  admin-visible number.

**Harder**
- Only instrumented things are measured; the score is proxies, not value.
- Confidence must be surfaced prominently or a sparse score reads as a real one.
- Needs the discipline to refuse "can the AI just tell us who's struggling?"
  when it is asked, which it will be.

**To revisit**
- Once a cohort has completed: fit the weights against real outcomes.
- Add model-generated flags-with-evidence beside the score — the B upside,
  without the B cost.
- Whether `responseLatency` earns its 0.05 at all. It is noisy and may be
  measuring timezone rather than engagement.

## Action Items

1. [x] Component list and default weights in policy
2. [ ] `signals` contributors: cadence adherence first
3. [ ] Composite scorer with density-derived confidence
4. [ ] Rules-plus-trend at-risk detection into an admin queue
5. [ ] Model-written explanation of the breakdown (never the number)
6. [ ] After cohort one: fit weights against outcomes, replay over history
