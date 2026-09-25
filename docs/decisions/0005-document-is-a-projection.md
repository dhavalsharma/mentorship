# ADR-0005: The database is the source of truth; the shared doc is a projection

**Status:** Accepted
**Date:** 2026-09-11
**Deciders:** abra (WeKan.AI)

## Context

After each session the platform writes up what was discussed — summary, action
items, goal progress — into a document both participants can see, and asks them
to confirm or request changes.

The brief said: put it in a shared Google Doc, share it on Slack, let both
agree or recommend changes, update the doc. Every clause there is reasonable and
together they raise a question that has to be answered explicitly: **when a
human edits the doc and the platform also writes to it, which one is right?**

Getting this wrong produces two specific failures. Either the renderer
overwrites someone's edit — which costs their trust permanently, because people
do not forgive a tool that eats their writing — or a render triggers a change
event which triggers a render, and the document flaps.

The extracted content also has to stay queryable: action items feed reminders,
goal deltas feed progress scoring. A document is not a queryable store.

## Decision

The database is the source of truth. The shared document is a **rendered
projection** of it, written into a marker-delimited managed region
(`<!-- mentorship:managed:start -->` … `end`). Everything outside the markers
belongs to the pair and is never touched.

Change requests are collected **in the conversation thread, not by parsing doc
edits**. The loop is: extract → render to the doc → post a summary with
confirm/change actions in the thread → apply accepted changes to the database →
re-render.

Three safeguards: **echo suppression** (ignore revisions authored by our own
service account), **pinning** (a human edit inside the managed region becomes a
human-authored override and that block stops being re-rendered), and
**unverified marking** (a timeout auto-confirms but labels it as unverified).

## Options Considered

### Option A: DB is truth, doc is a projection, thread is the control channel (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — managed region, echo suppression, pinning |
| Cost | Low |
| Data integrity | High |
| Team familiarity | High |

**Pros:** Extracted fields stay structured and queryable. The doc is the
readable artefact and the thread is the control channel, each doing what it is
good at. Adding Notion or Confluence is a new renderer against the same model.
Losing the document loses nothing.

**Cons:** People will edit the doc anyway, because it is a doc — so pinning is
mandatory, not optional. Two surfaces showing the same content can drift
visibly between a DB change and a re-render.

### Option B: The doc is the source of truth; parse it back

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — a parser for human-edited prose |
| Cost | Medium |
| Data integrity | Poor |
| Team familiarity | Medium |

**Pros:** Matches the user's mental model exactly — the doc is the thing, edit
it freely. No divergence, because there is only one copy.

**Cons:** Parsing a rewritten paragraph back into `{owner, text, dueAt}` is
guesswork, and guessing wrong silently corrupts action items that then drive
reminders. Reminders and scoring would depend on a document parse succeeding.
No reliable history. This is the option that looks friendliest and is the most
dangerous.

### Option C: Full bidirectional sync with conflict resolution

| Dimension | Assessment |
|-----------|------------|
| Complexity | Very high — CRDT or operational transform per provider |
| Cost | High |
| Data integrity | Good, if correct |
| Team familiarity | Low |

**Pros:** Edit anywhere, everything converges. The best experience if it works.

**Cons:** A real research-grade problem per document provider, and the
providers' APIs are not built for it. Wildly disproportionate to the value —
the content is a page of notes reviewed once.

## Trade-off Analysis

B is the intuitive reading of the brief and the wrong choice, because the
platform's downstream behaviour (reminders, progress) depends on structured
fields. Making those fields the output of a prose parse means a formatting
change can break a reminder, and the failure is silent.

The real cost of A is that it *asks* people to change things in the thread
rather than in the doc, which is mildly unnatural. Pinning is the concession:
if someone edits the managed region anyway, their edit wins and we stop
re-rendering that block. That keeps the promise that matters most — we never
eat your writing — while keeping the structured data authoritative.

C is deferred indefinitely. If a program genuinely needs collaborative editing
of the write-up, the right answer is to make the document the primary surface
for *narrative* content and keep structured fields in the DB, rather than to
sync both.

## Consequences

**Easier**
- Action items and goal deltas stay queryable and drive other primitives.
- Swapping document provider is a new renderer, not a new data model.
- Re-rendering is safe and repeatable.

**Harder**
- Pinning must actually be implemented before anyone edits a managed region, or
  the first overwrite loses a user's trust. *(Built — see Action Items 4–5.)*
- Echo suppression needs the service account identity per provider. *(Built —
  see Action Items 4–5.)*
- The thread becomes the place changes happen, which needs clear copy so it does
  not feel like a detour.
- Two surfaces can look briefly inconsistent.

**To revisit**
- Watch whether people edit the doc instead of replying in the thread. If most
  do, the copy is wrong or option C's narrative/structured split is needed.
- Whether the managed region should be visually marked in the doc so its
  behaviour is predictable rather than surprising.

## Action Items

1. [x] Managed-region markers; render from DB state
2. [x] Unverified marking on confirmation timeout — a banner *above* the
       write-up (`renderWriteUp`, `packages/core/src/document-projection.ts`);
       it first shipped replacing the write-up, found by the journey suite
       (bug #3)
3. [x] Internal-page fallback when no document slot is bound
4. [x] Echo suppression via service-account revision identity —
       `resolveManagedRegionWrite` (`packages/core/src/document-projection.ts`)
       takes an `isEcho` flag and never pins on it; `GoogleDriveDocumentAdapter`
       supplies it from Drive's own revision history
       (`isEchoRevision`/`lastModifyingUser.me`, `packages/integrations/src/google/document.ts`).
       `FakeDocument` tracks the same thing in-memory for tests
       (`packages/integrations/src/fakes.ts`).
5. [x] Pinning — detect a human edit in the region, capture it as an override,
       stop re-rendering that block. Implemented by the same
       `resolveManagedRegionWrite`: it compares the region's current content
       against what we last rendered, and a divergence that is not an echo is
       preserved (the render is skipped, not partially applied) with
       `pinned: true` on `DocumentAdapter.renderManagedRegion`'s result. The
       block stays pinned on every subsequent render until the doc's content
       matches our baseline again. Covered end to end in
       `packages/integrations/src/__tests__/fake-document.test.ts` and
       `packages/integrations/src/__tests__/google-document.test.ts`
       ("echo suppression and pinning"). Real document writes were already
       enabled in live testing before this landed (see CLAUDE.md's status
       table) — this closes that gap.
6. [ ] Make the managed region visibly demarcated for readers
