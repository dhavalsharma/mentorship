import postgres from "postgres";
import { migrate } from "./migrate.js";

/** Run with: pnpm db:migrate */

const url =
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5432/mentorship";

// `DROP POLICY IF EXISTS` on a fresh database emits a NOTICE per table, which
// postgres-js prints in full. They are expected, and forty of them bury the
// one line that matters.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const result = await migrate(sql, {
    onApplied: (name) => console.log(`  applied  ${name}`),
  });
  for (const name of result.alreadyApplied) console.log(`  current  ${name}`);
  console.log(
    result.applied.length === 0
      ? "\nNothing to apply."
      : `\nApplied ${result.applied.length} migration(s).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
