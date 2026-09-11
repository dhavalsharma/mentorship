# ADR-0006: Capabilities are probed per tenant, not inferred from the vendor

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

The session flow depends on external tools: a chat platform for the joint
thread, a calendar for free/busy and invites, a conferencing provider, a source
of transcripts, a document store.

The tempting assumption is that choosing a vendor determines what is possible —
"they use Google, so we get Meet transcripts". That assumption is false in a
way that matters. Whether a given organisation actually gets automatic meeting
transcripts depends on its subscription edition, its administrator's policy
settings, and sometimes the individual organiser's licence. Two tenants both
"on Google" can differ.

The failure mode is specific and bad: the saga enters `awaiting_artifact`,
polls five times over 24 hours for a transcript the tenant was never entitled
to, then finally asks for notes — a day late, having looked broken the whole
time.

Separately, some organisations will run on Teams, or on email alone, and the
platform has to work rather than refuse.

## Decision

Eight integration slots (`conversation`, `dm`, `calendar`, `conferencing`,
`transcript`, `document`, `sheet`, `dashboard`), each bound per program from
`policy.integrations`.

Every adapter implements `probe(): Promise<AdapterCapabilities>`, and the
registry **caches the probed result on the binding**. Capabilities are
discovered by asking, not declared by adapter type. Transcript entitlement
defaults to the pessimistic value.

Degradation lives in the effect runner: an empty slot takes a documented
fallback path rather than failing the step. The saga only branches on
capabilities that change the *flow* — chiefly whether to wait for a transcript
at all.

## Options Considered

### Option A: Probed capabilities, cached per binding (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — a probe per adapter, a cache, invalidation |
| Cost | Low — one probe per binding |
| Correctness | High — reflects the actual tenant |
| Team familiarity | Medium |

**Pros:** The manual-notes path becomes a first-class flow rather than an error
state, which is what a meaningful share of tenants will actually use. An admin
changing a setting is handled by re-probing. The same saga runs on Slack+Google,
on Teams, and on email alone, which is the concrete proof that the integration
layer is a boundary and not a hardcoded assumption.

**Cons:** Probing is per-provider work and not always cleanly possible —
transcript entitlement in particular may need an admin's confirmation or a test
meeting rather than an API call. Cached capabilities go stale when an
administrator changes policy, and nothing notifies us.

### Option B: Static capabilities per adapter type

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | None |
| Correctness | Wrong for a predictable fraction of tenants |
| Team familiarity | High |

**Pros:** Trivial. A table of vendor → features.

**Cons:** Produces exactly the failure this ADR exists to avoid. It is also the
kind of bug that is invisible in development (our test tenant has the feature)
and appears only at a customer, which is the worst place to find it.

### Option C: Try the operation and handle failure

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Cost | Low |
| Correctness | Reasonable for some operations, poor for transcripts |
| Team familiarity | High |

**Pros:** No probe to maintain. Reality is the source of truth, always fresh.

**Cons:** For transcripts the "failure" is indistinguishable from "not ready
yet", which is the whole problem — absence is not an error, so there is nothing
to catch. Worse, this design cannot distinguish *never coming* from *coming in
an hour*, which is precisely the distinction the saga needs.

## Trade-off Analysis

C is fine for operations with a clear error (creating an event fails loudly)
and useless for the one that matters most, because a missing transcript looks
identical whether the tenant is unentitled or the provider is slow.

A is chosen for that reason, with C as the complement rather than the
alternative: probe to decide the *flow*, and still handle operation failures
where they occur.

The honest weakness of A is that the transcript probe may not be a clean API
call. The design accommodates this by making entitlement an injected option on
the Google adapter (`transcriptEntitlement`) rather than pretending it is
discoverable — so it can be set by an admin's confirmation, a test meeting, or
a future API, without changing anything downstream. Defaulting it to `none`
means the worst case is asking for notes that were not needed, rather than
waiting a day for a transcript that never comes.

## Consequences

**Easier**
- Running on a different stack: change the profile, not the code.
- Showing an organisation what it gives up by leaving a slot empty
  (`DEGRADATION` is exported as data for exactly this).
- Testing degraded paths — the suite covers no-transcription and no-document.

**Harder**
- Each new adapter owes a real probe, and "what can this tenant do" is
  per-provider research.
- Cached capabilities go stale silently. Needs re-probe on failure and probably
  a periodic refresh.
- One exception to "degradation lives in the runner" must be remembered: a
  private message never falls back to the joint thread. It is the one
  degradation that makes things worse, and it is enforced in the `dm` handler.

**To revisit**
- How transcript entitlement is actually established per tenant during
  onboarding — an admin checkbox is honest; a silent guess is not.
- Whether stale capabilities need a scheduled refresh or only refresh-on-failure.

## Action Items

1. [x] Eight slots, `AdapterCapabilities`, registry with probe caching
2. [x] `DEGRADATION` map as data for the admin UI
3. [x] Saga branches on transcription capability and consent together
4. [x] Private messages never fall back to the joint thread
5. [ ] Onboarding flow that establishes transcript entitlement explicitly
6. [ ] Re-probe on failure; decide whether a periodic refresh is needed
