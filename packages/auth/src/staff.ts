import type { StaffRole } from "@mentorship/core";

/**
 * Who in an org is staff — the second question every admin route asks, after
 * `verifySession` has answered the first ("is this a real session?").
 *
 * Kept a separate port from `MagicLinkStore` on purpose. A magic link proves
 * control of an email address and nothing else; every invited mentee can do
 * that. Folding "and are they staff?" into the login store would make it one
 * forgotten call away from being skipped, which is exactly the hole this port
 * exists to close (ADR-0010). `apps/api` requires it wherever auth is wired.
 *
 * `null` means "not staff" — including a user id that does not exist in this
 * org, which under RLS is also what another org's user looks like. The caller
 * must not distinguish those: both are a 403.
 */
export interface StaffDirectory {
  staffRoleOf(orgId: string, userId: string): Promise<StaffRole | null>;
}
