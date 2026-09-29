import { and, asc, eq, isNotNull } from "drizzle-orm";
import { StaffRoleSchema, type StaffRole } from "@mentorship/core";
import { organizations, users, withTenant, type Db } from "@mentorship/db";
import { defaultDisplayName } from "./invites.js";
import { PostgresAuditSink } from "./postgres-enrollment.js";
import { isEmailAddress, normaliseEmail } from "./staff-requests.js";
import type {
  StaffAdminService,
  StaffMemberView,
  StaffRoleChangeOutcome,
} from "./server.js";

/**
 * Granting or clearing someone's staff role — the logic behind
 * `pnpm staff:grant` (`grant-staff.ts`), kept apart from argv parsing so it
 * can be tested against a real database.
 *
 * Two callers share it: the CLI, which is how a tenant's *first* admin is
 * made (ADR-0010 — nobody can reach an admin route before one exists, and an
 * operator with the database URL already holds that authority), and
 * `PUT /orgs/:orgId/staff`, where an existing admin grants or revokes from
 * the dashboard. One function so the two cannot drift on normalisation,
 * find-or-create, or the audit row.
 */

interface GrantStaffBase {
  orgId: string;
  email: string;
  /** `null` clears the role — "not staff" — without touching the user row otherwise. */
  staffRole: StaffRole | null;
  /** Used only when the user row does not exist yet; never overwrites a name. */
  displayName?: string;
}

/**
 * `pnpm staff:grant` — the operator, someone holding the database URL. Not
 * guarded: it may remove an org's last admin (revoking a compromised sole
 * admin is exactly what it exists for), and its authority is the database
 * URL, not a staff role, so there is no actor to re-check. `actorRef` is only
 * what the audit row records (the OS user).
 */
export interface OperatorGrantStaffInput extends GrantStaffBase {
  actorType?: "operator";
  actorRef?: string | null;
  protectLastAdmin?: false;
}

/**
 * `PUT /orgs/:orgId/staff` — an admin acting from the dashboard. Guarded
 * twice, both under the admin-set lock (see `grantStaffRole`): the actor must
 * *still* be an admin (`ActorNotAdminError`), and the change may not leave the
 * org with no admin (`LastAdminError` — an admin demoting the last admin,
 * themselves typically, would lock the tenant out of every admin-only screen
 * until an operator undid it). `actorRef` is required here because
 * the first check is made against it — a guarded grant with no actor would
 * have nobody's authority to re-check.
 */
export interface AdminGrantStaffInput extends GrantStaffBase {
  actorType: "admin";
  /** The acting admin's user id — re-checked under the lock, and the audit row's `actor_ref`. */
  actorRef: string;
  protectLastAdmin: true;
}

export type GrantStaffInput = OperatorGrantStaffInput | AdminGrantStaffInput;

/**
 * The change asked for would leave the org with zero admins. Thrown inside
 * the transaction, so nothing — role or audit row — is written.
 */
export class LastAdminError extends Error {
  constructor() {
    super("refusing to remove the organisation's last admin");
    this.name = "LastAdminError";
  }
}

/**
 * A guarded grant whose actor is no longer an admin by the time it holds the
 * admin-set lock — demoted while this request was queued behind that very
 * demotion. `authenticateStaff` checked the role in its own, earlier
 * transaction; this is the check that counts. Nothing is written, including
 * a user row the grant would have created.
 */
export class ActorNotAdminError extends Error {
  constructor() {
    super("the acting user is no longer an admin of this organisation");
    this.name = "ActorNotAdminError";
  }
}

/** `--role none` / "Remove access" for an email with no user row in this org. Nothing is written. */
export class UnknownStaffUserError extends Error {
  constructor(email: string) {
    super(`no user with email ${email} in this organisation`);
    this.name = "UnknownStaffUserError";
  }
}

export interface GrantStaffResult {
  userId: string;
  email: string;
  displayName: string;
  createdUser: boolean;
  before: StaffRole | null;
  after: StaffRole | null;
  /** False when the role was already what was asked for — no audit row then. */
  changed: boolean;
}

export { isEmailAddress, normaliseEmail } from "./staff-requests.js";

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
  if (!isEmailAddress(email)) {
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

      // Only a grant creates a user. Revoking someone who has no row has
      // nothing to revoke, and minting a row for a typo'd address just to
      // record that it is not staff would leave a stray user behind.
      const [inserted] =
        staffRole === null
          ? []
          : await tx
              .insert(users)
              .values({
                orgId: input.orgId,
                email,
                displayName: input.displayName?.trim() || defaultDisplayName(email),
              })
              .onConflictDoNothing({ target: [users.orgId, users.email] })
              .returning({ id: users.id });

      // The last-admin guard is a count, and a count is only true while
      // nobody else can change it: two admins demoting each other at once
      // would each see two admins, each pass, and leave none. So lock every
      // current admin row of the org first — `ORDER BY id`, so every guarded
      // grant takes the same locks in the same order and two of them queue
      // rather than deadlock. The second waits for the first to commit, and
      // READ COMMITTED then re-checks each locked row against the WHERE, so a
      // row the first transaction just demoted drops out of the second's
      // count. A concurrent *promotion* is not seen, which only ever
      // undercounts — the guard can refuse spuriously, never let through.
      const admins = input.protectLastAdmin
        ? await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.orgId, input.orgId), eq(users.staffRole, "admin")))
            .orderBy(asc(users.id))
            .for("update")
        : [];

      // The actor's authority, re-read under the same lock. The route's
      // `authenticateStaff` read it in an earlier transaction, so a request
      // that authenticated while another admin's demotion of this actor was
      // still open would otherwise queue on the lock above and then run with
      // stale authority — and since the last-admin guard only looks at the
      // *target*, a promotion (of themselves, or of an accomplice) would go
      // straight through. The lock makes that window reliable rather than
      // rare, so the check has to be here. A demotion committed ahead of us
      // has already dropped the actor's row out of `admins` (the READ
      // COMMITTED re-check above). The CLI skips this: its authority is the
      // database URL, not a role that can be revoked mid-request.
      if (input.protectLastAdmin && !admins.some((a) => a.id === input.actorRef)) {
        throw new ActorNotAdminError();
      }

      // FOR UPDATE: two concurrent grants for one person must serialise, or
      // both audit rows would record the same `before`. (For a guarded grant
      // whose target is an admin, this row is already locked above.)
      const [row] = await tx
        .select({ id: users.id, staffRole: users.staffRole, displayName: users.displayName })
        .from(users)
        .where(and(eq(users.orgId, input.orgId), eq(users.email, email)))
        .for("update")
        .limit(1);
      if (!row) {
        if (staffRole === null) throw new UnknownStaffUserError(email);
        throw new Error("user upsert found neither a new nor an existing row");
      }

      const parsedBefore = StaffRoleSchema.safeParse(row.staffRole);
      const before = parsedBefore.success ? parsedBefore.data : null;
      const result = {
        userId: row.id,
        email,
        displayName: row.displayName,
        createdUser: inserted !== undefined,
        before,
        after: staffRole,
      };
      if (before === staffRole) return { ...result, changed: false };

      if (
        input.protectLastAdmin &&
        before === "admin" &&
        staffRole !== "admin" &&
        !admins.some((a) => a.id !== row.id)
      ) {
        throw new LastAdminError();
      }

      await tx
        .update(users)
        .set({ staffRole, updatedAt: new Date() })
        .where(and(eq(users.orgId, input.orgId), eq(users.id, row.id)));

      await new PostgresAuditSink(tx).record({
        orgId: input.orgId,
        actorType: input.actorType ?? "operator",
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

export interface StaffMember {
  userId: string;
  email: string;
  displayName: string;
  role: StaffRole;
}

/**
 * Everyone in the org with a staff role, for `GET /orgs/:orgId/staff`. Inside
 * `withTenant`, so another org's staff are not merely filtered out by a
 * `WHERE` a later edit could drop — they are invisible under RLS. The role is
 * parsed, not cast, like `PostgresStaffDirectory`: a value this code does not
 * recognise is left out rather than shown as something it is not.
 */
export async function listStaffMembers(
  db: Db,
  orgId: string,
  options: { role?: string } = {},
): Promise<StaffMember[]> {
  const rows = await withTenant(
    db,
    orgId,
    (tx) =>
      tx
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          staffRole: users.staffRole,
        })
        .from(users)
        .where(and(eq(users.orgId, orgId), isNotNull(users.staffRole)))
        .orderBy(asc(users.email)),
    options.role === undefined ? {} : { role: options.role },
  );
  const members: StaffMember[] = [];
  for (const row of rows) {
    const role = StaffRoleSchema.safeParse(row.staffRole);
    if (role.success) {
      members.push({
        userId: row.userId,
        email: row.email,
        displayName: row.displayName,
        role: role.data,
      });
    }
  }
  return members;
}

/**
 * `StaffAdminService` over Postgres — the dashboard's door into
 * `grantStaffRole`. Always guarded (`protectLastAdmin` — the actor re-check
 * and the last-admin guard), always audited as the acting admin, so a dashboard change and a CLI change differ only in
 * who the audit row names and whether the org may end up with no admin.
 */
export class PostgresStaffAdminService implements StaffAdminService {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  list(orgId: string): Promise<StaffMemberView[]> {
    return listStaffMembers(this.db, orgId, this.options);
  }

  async setRole(
    orgId: string,
    change: { email: string; staffRole: StaffRole | null; displayName?: string },
    actorUserId: string,
  ): Promise<StaffRoleChangeOutcome> {
    try {
      const result = await grantStaffRole(
        this.db,
        {
          orgId,
          email: change.email,
          staffRole: change.staffRole,
          ...(change.displayName !== undefined ? { displayName: change.displayName } : {}),
          actorType: "admin",
          actorRef: actorUserId,
          protectLastAdmin: true,
        },
        this.options,
      );
      return {
        ok: true,
        member: {
          userId: result.userId,
          email: result.email,
          displayName: result.displayName,
          role: result.after,
        },
        changed: result.changed,
        createdUser: result.createdUser,
      };
    } catch (error) {
      if (error instanceof ActorNotAdminError) return { ok: false, reason: "actor_not_admin" };
      if (error instanceof LastAdminError) return { ok: false, reason: "last_admin" };
      if (error instanceof UnknownStaffUserError) return { ok: false, reason: "unknown_user" };
      throw error;
    }
  }
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
