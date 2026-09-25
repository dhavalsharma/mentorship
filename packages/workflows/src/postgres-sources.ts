import { and, desc, eq, sql } from "drizzle-orm";
import type { SessionSourceStore } from "@mentorship/core";
import { sessionNotes, withTenant, type Db } from "@mentorship/db";

/**
 * `SessionSourceStore` over `session_notes` — the table the schema always
 * meant raw transcripts to live in ("raw, untrusted, never mutated by
 * extraction"), and which nothing wrote until e2e bug #9: the transcript was
 * held in the effect runner's memory between the pass that fetched it and
 * the pass that extracted it, and a worker restart in between extracted from
 * an empty string.
 *
 * One row per (session, vendor ref), enforced by the partial unique index
 * from migration 0016 rather than a SELECT-then-INSERT that READ COMMITTED
 * lets two retries both pass. A retried fetch lands on it and stores nothing.
 */
export class PostgresSessionSourceStore implements SessionSourceStore {
  constructor(
    private readonly db: Db,
    private readonly options: { orgId: string; role?: string },
  ) {}

  private tenant<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const { orgId, role } = this.options;
    return withTenant(this.db, orgId, fn, role === undefined ? {} : { role });
  }

  async recordTranscript(input: {
    sessionId: string;
    ref: string;
    body: string;
  }): Promise<void> {
    await this.tenant((tx) =>
      tx
        .insert(sessionNotes)
        .values({
          orgId: this.options.orgId,
          sessionId: input.sessionId,
          kind: "transcript",
          externalRef: input.ref,
          body: input.body,
        })
        .onConflictDoNothing({
          target: [sessionNotes.orgId, sessionNotes.sessionId, sessionNotes.externalRef],
          where: sql`${sessionNotes.kind} = 'transcript'`,
        }),
    );
  }

  async transcript(input: { sessionId: string; ref: string }): Promise<string | null> {
    const [row] = await this.tenant((tx) =>
      tx
        .select({ body: sessionNotes.body })
        .from(sessionNotes)
        .where(
          and(
            eq(sessionNotes.orgId, this.options.orgId),
            eq(sessionNotes.sessionId, input.sessionId),
            eq(sessionNotes.kind, "transcript"),
            eq(sessionNotes.externalRef, input.ref),
          ),
        )
        .orderBy(desc(sessionNotes.createdAt))
        .limit(1),
    );
    return row?.body ?? null;
  }
}
