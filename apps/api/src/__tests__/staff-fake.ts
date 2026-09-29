import type { StaffDirectory } from "@mentorship/auth";
import type { StaffRole } from "@mentorship/core";
import type {
  StaffAdminService,
  StaffMemberView,
  StaffRoleChangeOutcome,
} from "../server.js";

/**
 * A `StaffAdminService` that writes through to a `FakeStaffDirectory`, so a
 * route test can change a role over HTTP and watch the very next request see
 * it. The last-admin rule is the same one `grantStaffRole` enforces; the
 * race half of it can only be proved on Postgres (`postgres-staff-roles.test.ts`).
 */
export class FakeStaffAdmin implements StaffAdminService {
  readonly people = new Map<string, { userId: string; displayName: string }>();
  readonly changes: { email: string; staffRole: StaffRole | null; actorUserId: string }[] = [];

  constructor(
    private readonly directory: FakeStaffDirectory,
    private readonly orgId: string,
  ) {}

  addPerson(email: string, userId: string, role: StaffRole | null, displayName = email): void {
    this.people.set(email, { userId, displayName });
    this.directory.set(this.orgId, userId, role);
  }

  async list(orgId: string): Promise<StaffMemberView[]> {
    const out: StaffMemberView[] = [];
    for (const [email, p] of this.people) {
      const role = await this.directory.staffRoleOf(orgId, p.userId);
      if (role !== null) out.push({ userId: p.userId, email, displayName: p.displayName, role });
    }
    return out;
  }

  async setRole(
    orgId: string,
    change: { email: string; staffRole: StaffRole | null; displayName?: string },
    actorUserId: string,
  ): Promise<StaffRoleChangeOutcome> {
    const email = change.email.trim().toLowerCase();
    let person = this.people.get(email);
    if (!person && change.staffRole === null) return { ok: false, reason: "unknown_user" };
    const createdUser = !person;
    if (!person) {
      person = { userId: `user-${this.people.size + 1}`, displayName: change.displayName ?? email };
      this.people.set(email, person);
    }
    const before = await this.directory.staffRoleOf(orgId, person.userId);
    const member = { userId: person.userId, email, displayName: person.displayName };
    if (before === change.staffRole) {
      return { ok: true, member: { ...member, role: before }, changed: false, createdUser };
    }
    if (before === "admin") {
      const admins = (await this.list(orgId)).filter((m) => m.role === "admin");
      if (admins.length <= 1) return { ok: false, reason: "last_admin" };
    }
    this.directory.set(orgId, person.userId, change.staffRole);
    this.changes.push({ email, staffRole: change.staffRole, actorUserId });
    return { ok: true, member: { ...member, role: change.staffRole }, changed: true, createdUser };
  }
}

/**
 * A Map-backed `StaffDirectory` for the route tests. `fallback` is what a
 * user nobody has `set` resolves to: suites that are about something other
 * than staff roles construct it with `"admin"` so their sessions keep the
 * access they had before `AuthDeps.staff` existed, and the staff-role suite
 * constructs it with `null` — nobody is staff until granted — which is what
 * Postgres does after migration 0017.
 */
export class FakeStaffDirectory implements StaffDirectory {
  private readonly roles = new Map<string, StaffRole | null>();
  readonly calls: { orgId: string; userId: string }[] = [];

  constructor(private readonly fallback: StaffRole | null = null) {}

  set(orgId: string, userId: string, role: StaffRole | null): void {
    this.roles.set(`${orgId}:${userId}`, role);
  }

  async staffRoleOf(orgId: string, userId: string): Promise<StaffRole | null> {
    this.calls.push({ orgId, userId });
    const key = `${orgId}:${userId}`;
    return this.roles.has(key) ? (this.roles.get(key) ?? null) : this.fallback;
  }
}
