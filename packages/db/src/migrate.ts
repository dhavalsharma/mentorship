import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

/**
 * A plain runner: every `.sql` file in `migrations/`, in filename order, each
 * inside its own transaction, recorded in `schema_migrations`.
 *
 * drizzle-kit's own migrator is deliberately not used. Half of these
 * migrations are hand-written — roles, RLS policies, grants — and teaching
 * drizzle's journal about files it did not generate is more moving parts than
 * reading a directory. The generated structural migration is renamed into the
 * same numbered sequence (see migrations/README.md) so one ordering governs
 * everything.
 *
 * Files run through the simple query protocol, which is what allows a single
 * file to hold several statements and a `DO $$ ... $$` block.
 */

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export interface MigrateOptions {
  dir?: string;
  onApplied?: (name: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(
  sql: Sql,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;

  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const rows = await sql<{ name: string }[]>`select name from schema_migrations`;
  const done = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      alreadyApplied.push(file);
      continue;
    }
    const text = await readFile(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text).simple();
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    applied.push(file);
    options.onApplied?.(file);
  }

  return { applied, alreadyApplied };
}
