import { z } from "zod";
import { StaffRoleSchema, type StaffRole } from "@mentorship/core";

/**
 * The HTTP half of staff management — kept apart from `staff-grants.ts`
 * (which imports `@mentorship/db`) so `server.ts` stays driver-free, the
 * same split `invites.ts` makes for the invite route.
 */

/**
 * Same normalisation `planInvite` applies, and `requestMagicLink` applies to
 * whatever is typed at /login — so a grant, an invite and a sign-in for one
 * address all land on one row, whatever case it is typed in.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The rule `grantStaffRole` refuses on, shared with the route's schema so a
 * 400 and a thrown grant can never disagree about what an email is (it is
 * also `planInvite`'s rule).
 */
export function isEmailAddress(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(email));
}

/**
 * The body of `PUT /orgs/:orgId/staff`. `role: "none"` revokes — a word, not
 * an absent field or a `null`, for the reason the CLI's `--role none` is one:
 * taking someone's access away should never be what a forgotten field does.
 * `.strict()` so a typo'd field is a 400 naming it rather than a silent drop.
 */
export const StaffRoleChangeRequestSchema = z
  .object({
    email: z
      .string({ required_error: "email is required" })
      .trim()
      .min(1, "email is required")
      .refine(isEmailAddress, "not an email address"),
    role: z.enum(["admin", "program_lead", "none"], {
      errorMap: () => ({ message: "role must be admin, program_lead or none" }),
    }),
    /** Used only when no user with that email exists yet; never renames anyone. */
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type StaffRoleChangeRequest = z.infer<typeof StaffRoleChangeRequestSchema>;

/** `"none"` on the wire, `null` in the grant — the column's own spelling of "not staff". */
export function requestedStaffRole(role: StaffRoleChangeRequest["role"]): StaffRole | null {
  return role === "none" ? null : StaffRoleSchema.parse(role);
}
