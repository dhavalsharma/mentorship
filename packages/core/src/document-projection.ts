/**
 * The comparison logic behind ADR-0005's two safeguards — echo suppression
 * and pinning — lives here rather than in any adapter, because it is exactly
 * the same decision regardless of which vendor's doc is on the other end:
 * given what we are about to render, what is actually sitting in the managed
 * region right now, and what we rendered there last time, decide whether this
 * is an untouched region (render), our own write echoing back (render — it is
 * not a human edit), or a genuine human edit (preserve it, and say so, so the
 * caller can stop treating this block as ours to overwrite).
 *
 * A vendor adapter's only job is to answer one yes/no question this function
 * cannot: "was the current revision authored by us?" That check is
 * necessarily vendor-specific (a Drive revision's `lastModifyingUser`, a
 * Notion page's last-edited-by, ...) and stays in `integrations/<vendor>`.
 * Nothing here, or in `DocumentAdapter`, ever learns the word "Drive".
 */

export interface ManagedRegionWrite {
  /** What should end up in the managed region after this render. */
  text: string;
  /**
   * True when a human edit inside the region was detected and preserved
   * instead of being overwritten — the caller must not write `markdown`,
   * only `text` (which is the preserved human content), and should treat the
   * block as pinned until some later render sees the baseline restored.
   */
  pinned: boolean;
}

export function resolveManagedRegionWrite(input: {
  /** What we would render this time, from current DB state. */
  markdown: string;
  /**
   * The managed region's current content in the document, or `null` when the
   * region does not exist yet (a fresh document, or markers not yet seeded).
   */
  currentRegionText: string | null;
  /**
   * What we ourselves last rendered into this region, or `null` if this is
   * the first render we know of (nothing to compare against, so there is
   * nothing to protect yet).
   */
  lastRendered: string | null;
  /**
   * Whether the document's current revision was authored by our own service
   * account. When true, any divergence from `lastRendered` is our own write
   * reappearing as a "change" (a re-fetch, a formatting round-trip, ...),
   * never a human edit, and must not trigger pinning.
   */
  isEcho: boolean;
}): ManagedRegionWrite {
  // Nothing to compare against yet: render normally. This also covers the
  // very first render of a brand new document.
  if (input.currentRegionText === null || input.lastRendered === null) {
    return { text: input.markdown, pinned: false };
  }

  // Our own prior write reappearing as a "change" is not a human edit —
  // never pin on it, regardless of whether the bytes match `lastRendered`.
  if (input.isEcho) {
    return { text: input.markdown, pinned: false };
  }

  // The region no longer matches what we last put there, and the revision
  // that changed it was not ours: a human edited it. Their edit wins — we
  // never eat someone's writing (ADR-0005) — and this block stops being
  // re-rendered until the divergence is resolved some other way.
  if (input.currentRegionText !== input.lastRendered) {
    return { text: input.currentRegionText, pinned: true };
  }

  return { text: input.markdown, pinned: false };
}
