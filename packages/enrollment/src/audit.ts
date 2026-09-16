/**
 * `audit_log` already exists in the schema (`packages/db/src/schema.ts`) but,
 * as of this package, nothing writes to it yet — confirmed with
 * `grep -rn "auditLog" packages apps`, which turns up only the table
 * definition and its re-export from `schema`. Enrollment is a natural first
 * writer: inviting someone and verifying their identity are exactly the kind
 * of "who did what, before/after" actions this table exists for.
 *
 * `AuditSink` is a structural subset of the `audit_log` columns — no new
 * columns invented, and no dependency on `@mentorship/db` to describe them.
 */
export interface AuditSink {
  record(input: {
    orgId: string;
    actorType: string;
    actorRef: string | null;
    action: string;
    subjectRef: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void>;
}
