import { userInfo } from "node:os";
import { createClient } from "@mentorship/db";
import { GRANT_STAFF_USAGE, grantStaffRole, parseGrantStaffArgs } from "./staff-grants.js";

/**
 * Grant or clear an org-chart staff role (ADR-0010). Nobody can reach the
 * admin dashboard until someone has run this for them — migration 0017
 * deliberately makes nobody staff, because granting existing users admin
 * would reopen the hole it closes.
 *
 *   DATABASE_URL=… ORG_ID=… pnpm staff:grant --email ada@example.com --role admin
 *   DATABASE_URL=… ORG_ID=… pnpm staff:grant --email ada@example.com --role none
 *
 * This is the bootstrap: once an org has an admin, they grant and revoke
 * everyone else from `/dashboard/settings/staff` (`PUT /orgs/:orgId/staff`,
 * the same `grantStaffRole` below). Unlike the route, this command may remove
 * an org's last admin — it is the operator, the authority that guard defers to.
 *
 * A grant creates the user if they do not exist (so the first admin can
 * sign in); `--role none` for an email with no user here creates nothing and
 * fails with `UnknownStaffUserError`. Never overwrites an existing name or zone, and writes `staff.role_changed`
 * to `audit_log` in the same transaction. `TENANT_ROLE` is honoured like
 * everywhere else, so this can run as `mentorship_app` under RLS.
 */

const DATABASE_URL = process.env["DATABASE_URL"];
const ORG_ID = process.env["ORG_ID"];
const TENANT_ROLE = process.env["TENANT_ROLE"];

if (!DATABASE_URL || !ORG_ID) {
  console.error("DATABASE_URL and ORG_ID are both required");
  console.error(GRANT_STAFF_USAGE);
  process.exit(1);
}

const args = parseGrantStaffArgs(process.argv.slice(2).filter((a) => a !== "--"));
if (!args.ok) {
  console.error(args.error);
  console.error(GRANT_STAFF_USAGE);
  process.exit(1);
}

const { db, sqlClient } = createClient(DATABASE_URL);
try {
  const result = await grantStaffRole(
    db,
    {
      orgId: ORG_ID,
      email: args.email,
      staffRole: args.staffRole,
      ...(args.displayName ? { displayName: args.displayName } : {}),
      // The OS user who ran the command — the best "who decided this" an
      // out-of-band grant has, and better than an empty actor_ref.
      actorRef: `cli:${safeUsername()}`,
    },
    TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE },
  );
  const describe = (role: string | null) => role ?? "not staff";
  console.log(
    `${result.email} (user ${result.userId}${result.createdUser ? ", created" : ""}): ` +
      (result.changed
        ? `${describe(result.before)} -> ${describe(result.after)}`
        : `already ${describe(result.after)}, nothing changed`),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sqlClient.end();
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
