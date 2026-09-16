/**
 * Client-side email shape check before hitting `/api/auth/request-link`.
 * Deliberately loose — the backend is the source of truth for whether an
 * account exists, and this app must never try to be a stricter gate than
 * that (see the enumeration-safety notes on `requestMagicLink`). This only
 * catches "clearly not an email" typos before spending a round trip.
 */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
