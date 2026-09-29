import { and, eq } from "drizzle-orm";
import { StaffRoleSchema, type StaffRole } from "@mentorship/core";
import { organizations, users, withTenant, type Db } from "@mentorship/db";
import { defaultDisplayName } from "./invites.js";
import { PostgresAuditSink } from "./postgres-enrollment.js";

/**
 * Granting or clearing someone's staff role — the logic behind
 * `pnpm staff:grant` (`grant-staff.ts`), kept apart from argv parsing so it
 * can be tested against a real database.
 *
 * Out of band on purpose (ADR-0010): the first admin of a tenant cannot be
 * granted through an admin route, because nobody can reach one yet, and
 * granting from the UI is a separate, not-yet-built step. An operator with
 * the database URL is the one party who already holds that authority.
 */

export interface GrantStaffInput {
  orgId: string;
  email: string;
  /** `null` clears the role — "not staff" — without touching the user row otherwise. */
  staffRole: StaffRole | null;
  /** Used only when the user row does not exist yet; never overwrites a name. */
  displayName?: string;
  /** Recorded as the audit row's `actor_ref` — who ran the grant. */
  actorRef?: string | null;
}

export interface GrantStaffResult {
  userId: string;
  email: string;
  createdUser: boolean;
  before: StaffRole | null;
  after: StaffRole | null;
  /** False when the role was already what was asked for — no audit row then. */
  changed: boolean;
}

/** Same normalisation `planInvite` applies, so the grant and the magic link find one row. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * One `withTenant` transaction: find-or-create the user, set the role, and
 * write `staff.role_changed` with the old and new role alongside it — so a
 * role can never change without its audit row, nor the row exist for a
 * change that rolled back.
 *
 * A new user row gets `tz_offset_minutes`'s column default, like an invite
 * does; an existing row's name and zone are left exactly as they were. A
 * no-op grant (already that role) writes nothing, audit included, so running
 * the command twice does not read as two decisions.
 */
export async function grantStaffRole(
  db: Db,
  input: GrantStaffInput,
  options: { role?: string } = {},
): Promise<GrantStaffResult> {
  const email = normaliseEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`not an email address: ${input.email}`);
  }
  const staffRole = input.staffRole === null ? null : StaffRoleSchema.parse(input.staffRole);

  return withTenant(
    db,
    input.orgId,
    async (tx) => {
      // `users.org_id` has no foreign key, so a mistyped ORG_ID would
      // otherwise mint an admin of an organisation that does not exist —
      // harmless, but a grant that silently did nothing useful. A tenant may
      // read its own `organizations` row under RLS (0002).
      const [org] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);
      if (!org) throw new Error(`no organisation with id ${input.orgId}`);

      const [inserted] = await tx
        .insert(users)
        .values({
          orgId: input.orgId,
          email,
          displayName: input.displayName?.trim() || defaultDisplayName(email),
        })
        .onConflictDoNothing({ target: [users.orgId, users.email] })
        .returning({ id: users.id });

      // FOR UPDATE: two concurrent grants for one person must serialise, or
      // both audit rows would record the same `before`.
      const [row] = await tx
        .select({ id: users.id, staffRole: users.staffRole })
        .from(users)
        .where(and(eq(users.orgId, input.orgId), eq(users.email, email)))
        .for("update")
        .limit(1);
      if (!row) throw new Error("user upsert found neither a new nor an existing row");

      const parsedBefore = StaffRoleSchema.safeParse(row.staffRole);
      const before = parsedBefore.success ? parsedBefore.data : null;
      const result = {
        userId: row.id,
        email,
        createdUser: inserted !== undefined,
        before,
        after: staffRole,
      };
      if (before === staffRole) return { ...result, changed: false };

      await tx
        .update(users)
        .set({ staffRole, updatedAt: new Date() })
        .where(and(eq(users.orgId, input.orgId), eq(users.id, row.id)));

      await new PostgresAuditSink(tx).record({
        orgId: input.orgId,
        actorType: "operator",
        actorRef: input.actorRef ?? null,
        action: "staff.role_changed",
        subjectRef: `user:${row.id}`,
        before: { staffRole: before },
        after: { staffRole },
      });
      return { ...result, changed: true };
    },
    options.role === undefined ? {} : { role: options.role },
  );
}

export type ParsedGrantArgs =
  | { ok: true; email: string; staffRole: StaffRole | null; displayName?: string }
  | { ok: false; error: string };

export const GRANT_STAFF_USAGE =
  "usage: pnpm staff:grant --email <address> --role admin|program_lead|none [--name <display name>]";

/**
 * `--flag value` or `--flag=value`. `--role none` clears the role; it is a
 * word rather than an absent flag so revoking someone is never the result of
 * forgetting an argument.
 */
export function parseGrantStaffArgs(argv: readonly string[]): ParsedGrantArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) return { ok: false, error: `unexpected argument: ${arg}` };
    const eqAt = arg.indexOf("=");
    const key = eqAt === -1 ? arg.slice(2) : arg.slice(2, eqAt);
    const value = eqAt === -1 ? argv[++i] : arg.slice(eqAt + 1);
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `--${key} needs a value` };
    }
    if (!["email", "role", "name"].includes(key)) {
      return { ok: false, error: `unknown flag: --${key}` };
    }
    values.set(key, value);
  }

  const email = values.get("email");
  if (!email) return { ok: false, error: "--email is required" };
  const role = values.get("role");
  if (!role) return { ok: false, error: "--role is required (admin, program_lead or none)" };

  let staffRole: StaffRole | null;
  if (role === "none") {
    staffRole = null;
  } else {
    const parsed = StaffRoleSchema.safeParse(role);
    if (!parsed.success) {
      return { ok: false, error: `--role must be admin, program_lead or none, not ${role}` };
    }
    staffRole = parsed.data;
  }

  const name = values.get("name");
  return { ok: true, email, staffRole, ...(name ? { displayName: name } : {}) };
}
