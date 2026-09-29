/**
 * A per-key cooldown for outbound mail: the first `allow(key)` in a window
 * returns true and starts it, every later one returns false until it ends.
 *
 * Why it exists: `/auth/request-link` is unauthenticated, so without this a
 * loop against a *known* address floods that inbox and burns the shared
 * mailbox's daily Gmail quota (docs/email-setup.md), after which every real
 * sign-in fails. The cooldown only ever suppresses the *send* — the link is
 * still minted and valid, and the HTTP response is decided before this runs.
 *
 * Bounded on purpose: the map is keyed by an address, and only known
 * addresses reach it, but an unbounded map is still a memory-growth lever.
 * At `maxEntries` it drops expired entries, then the oldest. Evicting the
 * oldest lets that one address be mailed again early; the alternative
 * (refusing new keys when full) would let a burst lock real people out.
 *
 * In-process, so a deployment with N api processes allows up to N mails per
 * window per address, and a restart forgets everything. Both are accepted
 * (ADR-0011); a shared limit belongs at the edge or in Postgres.
 */

export interface CooldownOptions {
  /** 0 disables the cooldown: every `allow` is true. */
  seconds: number;
  now?: () => number;
  maxEntries?: number;
}

export const DEFAULT_COOLDOWN_SECONDS = 60;
export const DEFAULT_COOLDOWN_MAX_ENTRIES = 10_000;

export interface Cooldown {
  allow(key: string): boolean;
  readonly size: number;
}

export function createCooldown(options: CooldownOptions): Cooldown {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.seconds * 1000;
  const max = Math.max(1, options.maxEntries ?? DEFAULT_COOLDOWN_MAX_ENTRIES);
  // Insertion order == expiry order (every entry has the same window), so the
  // first key is always the oldest.
  const until = new Map<string, number>();

  return {
    get size() {
      return until.size;
    },
    allow(key) {
      if (windowMs <= 0) return true;
      const t = now();
      const live = until.get(key);
      if (live !== undefined && live > t) return false;
      until.delete(key); // re-insert at the end
      if (until.size >= max) {
        for (const [k, expiry] of until) {
          if (expiry > t) break;
          until.delete(k);
        }
        while (until.size >= max) {
          const oldest = until.keys().next();
          if (oldest.done) break;
          until.delete(oldest.value);
        }
      }
      until.set(key, t + windowMs);
      return true;
    },
  };
}

/** `MAGIC_LINK_EMAIL_COOLDOWN_SECONDS`: unset = 60, 0 = off, anything else invalid throws at boot. */
export function cooldownSecondsFromEnv(env: { MAGIC_LINK_EMAIL_COOLDOWN_SECONDS?: string | undefined }): number {
  const raw = env.MAGIC_LINK_EMAIL_COOLDOWN_SECONDS?.trim();
  if (!raw) return DEFAULT_COOLDOWN_SECONDS;
  if (!/^\d+$/.test(raw) || Number(raw) > 86_400) {
    throw new Error("MAGIC_LINK_EMAIL_COOLDOWN_SECONDS must be a whole number of seconds, 0 to 86400");
  }
  return Number(raw);
}
