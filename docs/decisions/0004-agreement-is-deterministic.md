# ADR-0004: Agreement resolution is deterministic, with five outcomes

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

The planner proposes times to two people in a shared thread and books the
meeting "if they agree". That phrase hides a state machine.

Two parties, each of whom may accept (one of several options), counter with a
different time, decline, or say nothing — and may change their mind. The
combinations are not two outcomes but at least five, and the ones that get
skipped in a first implementation are exactly the ones that cause damage: both
people accept *different* slots; one accepts and the other never replies;
the two counter each other indefinitely.

The stakes are asymmetric. Failing to book a meeting is a mild annoyance.
Booking a meeting nobody agreed to, or double-booking, destroys trust in the
tool permanently.

## Decision

`agreements` is a first-class table. `resolveAgreement(agreement, policy, now)`
is a pure function returning one of:

- `accepted` (with the option, and whether it was unanimous)
- `conflict` — both accepted, different options
- `countered` — earliest counter wins the round
- `declined`
- `stalled` — `no_response` or `partial_response`
- `pending`

Responses are structured (`accept` with an option id, `counter` with an
alternative, `decline`), collected through buttons or a structured reply.
Last response per participant wins. Rounds are capped at two by policy, then a
human. Silence gets one renudge, then escalation.

Never parse agreement from prose.

## Options Considered

### Option A: Deterministic resolver over structured responses (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one pure function, twelve tests |
| Cost | None |
| Correctness | High — exhaustive and reproducible |
| Team familiarity | High |

**Pros:** Auditable: the row shows exactly who said what and when, which
matters when someone asks why a meeting was booked. Trivially testable — every
outcome is a unit test with no clock and no model. Policy-tunable
(`require_both` vs `proceed_on_one`) without touching logic.

**Cons:** Requires the conversation adapter to support structured responses,
or a fallback path for one that does not. Rigid: a participant who replies
"Tuesday works but only after 3" is not expressible and falls through to a
counter or a human.

### Option B: An LLM reads the thread and decides whether they agreed

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to write |
| Cost | Per-message inference, on every reply |
| Correctness | Unbounded failure mode |
| Team familiarity | Medium |

**Pros:** Handles natural replies, including "yeah Tues is fine" and "can we do
the week after instead?". No buttons needed, so it works on any channel.

**Cons:** The failure mode is booking a meeting from a misread message. "I
can't do Tuesday" and "I can do Tuesday" differ by one token. It is also not
meaningfully testable — you cannot assert an invariant against a classifier —
and it makes the audit trail a model output rather than a record of what people
said. This is the single place in the system where a wrong inference is most
costly, which is the strongest possible argument against putting inference
there.

### Option C: Structured responses, with an LLM only to interpret free-text replies

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Low — only on unstructured replies |
| Correctness | Good, if the model's output is constrained to proposing |
| Team familiarity | Medium |

**Pros:** Keeps the deterministic core while accepting natural language. The
model's job is narrow: map free text onto one of the offered options or a
counter, and surface it for confirmation rather than acting on it.

**Cons:** More moving parts, and a second confirmation step risks feeling
pedantic. Not needed while the primary channel has buttons.

## Trade-off Analysis

B is rejected on blast radius, not on capability. The model would usually be
right; "usually" is not a standard that survives a double booking in front of a
mentor and a mentee.

C is the right eventual answer and is deliberately deferred. The seam exists:
a free-text reply can become a `counter` proposal that re-enters the same
deterministic resolver, so adding C later changes the *input* path and not the
decision logic. Note that under C the model still never decides agreement — it
only suggests what the person meant, and the structured resolver still rules.

The rigidity cost of A is mitigated by "suggest another" being a first-class
response, which routes a partial constraint to a new round rather than losing
it.

## Consequences

**Easier**
- Auditing: `agreements.responses` is the record.
- Testing: every outcome including conflict and partial-timeout is a unit test.
- Tuning per program: `proceed_on_one` for programs that would rather
  over-schedule than stall.

**Harder**
- Channels without interactive components need a path. Currently the adapter
  declares `interactiveApproval: false`, a warning is logged, and the message
  is still posted — but nothing collects a structured reply. **This is an open
  gap**, and the honest resolution is either option C or an in-app fallback.
- A participant's nuanced reply gets flattened into counter-or-human.
- `conflict` re-proposes rather than picking one, which costs a round but is
  the only defensible behaviour.

**To revisit**
- Implement C once a non-interactive channel is a real requirement.
- Whether `proceed_on_one` should be allowed at all. It is defensible for
  over-scheduling-tolerant programs and indefensible if it ever books time for
  someone who never answered. Currently the message says so explicitly; that
  may not be enough.

## Action Items

1. [x] `resolveAgreement` with all five outcomes, twelve tests
2. [x] Round cap, renudge-once, escalation
3. [x] Slack Block Kit buttons carrying agreement and option ids
4. [ ] Interaction endpoint: verify signature, ack within the deadline, write
       `agreement.responded`, advance asynchronously
5. [ ] Close the non-interactive-channel gap (option C, or an in-app fallback)
