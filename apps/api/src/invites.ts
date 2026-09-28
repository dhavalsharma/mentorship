import { z } from "zod";

/**
 * The body of `POST /orgs/:orgId/invites`. This is the HTTP shape only —
 * `planInvite` still owns the domain validation (email format and
 * normalisation), so the two never disagree about what a valid email is.
 * The request schema only insists an email is *present*.
 *
 * `displayName` and `tzOffsetMinutes` are optional because an admin inviting
 * someone by email usually knows neither; see `defaultDisplayName` and the
 * route's comment on the zone default. `.strict()` so a typo'd field
 * (`cohort_id`) is a 400 naming it rather than a silently dropped value.
 */
export const InviteRequestSchema = z
  .object({
    email: z.string({ required_error: "email is required" }).trim().min(1, "email is required"),
    cohortId: z
      .string({ required_error: "cohortId is required" })
      .uuid("cohortId must be a UUID"),
    role: z
      .string({ required_error: "role is required" })
      .trim()
      .min(1, "role is required")
      .max(64),
    displayName: z.string().trim().min(1).max(200).optional(),
    /** Minutes east of UTC, as `users.tz_offset_minutes` stores it: UTC−12 to UTC+14. */
    tzOffsetMinutes: z.number().int().min(-720).max(840).optional(),
    capacity: z.number().int().nonnegative().max(1000).optional(),
  })
  .strict();
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

/**
 * `users.display_name` is NOT NULL, and an invite by email alone has nothing
 * better — the local part is what every mail client would show anyway, and
 * it is only ever written onto a user row that does not exist yet.
 */
export function defaultDisplayName(email: string): string {
  const local = email.trim().split("@")[0] ?? "";
  return local.length > 0 ? local : email.trim();
}
