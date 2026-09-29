import type { StaffDirectory } from "@mentorship/auth";
import type { StaffRole } from "@mentorship/core";

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
