# ADR-0009: Pairs choose their own session length and rhythm

**Status:** Accepted
**Date:** 2026-09-23
**Deciders:** dhaval (WeKan.AI)

## Context

Session length and frequency were program policy (`cadence.sessionMinutes`,
`cadence.everyDays`), optionally narrowed per cohort, and — through roster
import only — per pair. Once a pair was running, the two people actually
meeting had no way to say "30 minutes is plenty" or "we'd rather meet weekly
for the first month". An admin had to edit data on their behalf, or the pair
quietly ignored the proposals, which the progress primitive then reads as a
pair falling behind.

The pieces needed were mostly already there. `pairings.cadence_override`
existed, and `resolveCadence(program, cohort, pair)` already merged the pair
level last — so every reader (the saga's slot search and booking, the nudge
sweep's deficit detection, cadence adherence) would follow a pair-level value
without knowing where it came from. What was missing was a door the pair could
use, and a rule for what that door accepts.

## Decision

**Either member of a pair may set the pair's session length and rhythm, from a
structured control, and the change lands on `pairings.cadence_override`.**

- The menu is **policy**, not code: `policy.pairPreferences` holds
  `sessionMinuteChoices` (default 15/30/45), `cadenceDayChoices` (default
  7/14/21/28 — every one to four weeks), whether a custom value is allowed for
  each, and an `enabled` switch for programs that fix both centrally.
- The control is a **"Session preferences" button on every proposal**, opening
  a Slack modal (two selects, two optional number fields for "custom"). Opened
  synchronously inside the click's request, for the same three-second
  `trigger_id` reason as the counter modal (ADR-0004's follow-up).
- Validation lives in core (`resolvePairPreferences`) and checks against the
  **program's menu**, not merely the schema's bounds — a forged "90 minutes"
  is refused when the program offers 15/30/45 with no custom.
- The API writes the override **and** a `pair.preferences_updated` event in one
  transaction (the outbox), and answers the modal with what now applies.
- The override is **merged**, never replaced: a pair changing only its length
  keeps the rhythm roster import gave it. The label follows `everyDays`, so
  copy never calls a weekly pair "fortnightly".
- A `SessionLifecycle` in `cooling` waits on `pair.preferences_updated`,
  recomputes its wake time from the same `lastSessionAt`, and posts one line
  to the pair's thread naming who changed what. Every other state simply reads
  the new cadence the next time it builds a proposal.
- Every proposal states the slot length when choice is enabled *and* the
  conversation adapter can render the button, so the thing a pair can change
  is visible where they'd want to change it — and a proposal degraded to plain
  DMs never points at a control that isn't there.
- Sagas already in `cooling` when this shipped were given the same wait by a
  one-off data migration (`0013_cooling_preferences_wait.sql`), so no pair
  has to wait out a full cycle on the old rhythm.

Roster import gained a `duration` column (aliases `session_minutes`,
`session_length`, `meeting_length`, `meeting_duration`, `length`) and learned
`every 3 weeks` / `4 weeks` for cadence, so an admin can seed the same values a
pair can later pick.

## Options Considered

### Option A: Unilateral, structured, announced (chosen)

**Pros:** One click for the common case. No new table and no new resolver —
the existing pair override and `resolveCadence` do all the downstream work.
Structured end to end, so invariant 9 holds. The other member is told in the
thread when the pair is between sessions, and every proposal restates the
length.

**Cons:** One member can change the rhythm without the other's agreement. The
mitigation is visibility, not consent: the change is announced and either
member can change it back in the same two clicks.

### Option B: A second agreement round (both must accept the change)

Reuse `agreements` with a new `subject`, and apply the change only when both
accept.

**Pros:** Symmetric; nothing changes that both people did not agree to.

**Cons:** `agreements` and its resolver are shaped around choosing a time slot
(options with start/end, counters, rounds) — a second subject means either
generalising the resolver or bolting on a parallel one. It also makes a trivial
preference as heavy as scheduling a meeting. Rejected for now; if pilots show
one-sided changes causing friction, this is the upgrade path, and the
`pair.preferences_updated` event is already the right hook for it.

### Option C: Read it out of the thread ("let's make it weekly")

**Cons:** Invariant 9. Rejected without further discussion.

### Option D: Admin-only (web dashboard setting per pair)

**Pros:** Central control.

**Cons:** Solves the admin's problem, not the pair's — and puts every pair's
logistics through one person. A program that wants this sets
`pairPreferences.enabled: false` and edits the pair override directly; the two
are not exclusive.

## Consequences

**What becomes easier:** A program offering flexible mentoring needs no code
change — it edits `policy.pairPreferences`. Health, nudges and adherence stay
fair to a pair that deliberately meets every four weeks.

**What becomes harder:**

- A pair can drift away from the program's intended rhythm without an admin
  noticing. The event log records every change (`pair.preferences_updated`
  with `participantId` and `changed`), but no dashboard reads it yet.
- The thread announcement only fires while the saga is `cooling`. A change made
  while a proposal is open or a session is booked is not announced at that
  moment; it shows up in the next proposal's wording. Listening in every state
  was rejected as noise in each state's `waitFor` — and `proposing` waits on
  the agreement's subject, not the pairing's, so it cannot listen without a
  second pattern. The modal says so in as many words rather than promising an
  announcement it cannot always make.
- An ad-hoc pair (`everyDays: 0`) finishes its saga after each session, so
  choosing a rhythm afterwards is stored but does not restart a saga. The menu
  never offers 0, and the program-level `adhoc` convention is unchanged.
- Changing length mid-negotiation does not re-propose; the open options keep
  their original length. The next proposal uses the new one.

## Action Items

1. [x] `PairPreferencesPolicySchema` on `ProgramPolicy`; `resolvePairPreferences`,
       `applyPairPreferences`, labels — `packages/core/src/pair-preferences.ts`
2. [x] Slack button, modal, submission handling —
       `packages/integrations/src/slack/{conversation,modal,interactions}.ts`
3. [x] `PostgresPairPreferencesStore` (`apps/api/src/postgres-ports.ts`) and
       the in-memory `World` counterpart
4. [x] Cooling saga re-times on `pair.preferences_updated`
5. [x] Roster `duration` column
6. [ ] Run the modal against a live sandbox workspace
7. [ ] Surface preference changes to admins (a digest line, or a dashboard view
       over `pair.preferences_updated`)
