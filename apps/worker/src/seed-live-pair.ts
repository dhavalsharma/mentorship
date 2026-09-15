import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { defaultPolicy, subjectRef } from "@mentorship/core";
import {
  cohorts,
  createClient,
  identityLinks,
  organizations,
  pairings,
  participants,
  programs,
  users,
} from "@mentorship/db";
import { PostgresEventSink } from "@mentorship/workflows/postgres";

/**
 * Everything the manual `docker compose exec db psql` walkthrough in
 * docs/live-tenant-testing.md did by hand, as one command. Running it twice
 * with the same ORG_ID reuses the org rather than duplicating it — the
 * pairing itself is not reused, because "a fresh pair to click through" is
 * usually the point of running it again.
 *
 * Reads: ORG_ID (created if it does not exist), MENTOR_EMAIL,
 * MENTOR_SLACK_ID, MENTEE_EMAIL, MENTEE_SLACK_ID, and DATABASE_URL.
 *
 * Run with: pnpm seed:live-pair
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const DATABASE_URL = required("DATABASE_URL");
const ORG_ID = process.env["ORG_ID"] ?? randomUUID();
const MENTOR_EMAIL = required("MENTOR_EMAIL");
const MENTOR_SLACK_ID = required("MENTOR_SLACK_ID");
const MENTEE_EMAIL = required("MENTEE_EMAIL");
const MENTEE_SLACK_ID = required("MENTEE_SLACK_ID");
const MENTOR_NAME = process.env["MENTOR_NAME"] ?? "Mentor";
const MENTEE_NAME = process.env["MENTEE_NAME"] ?? "Mentee";
const MENTOR_TZ_OFFSET = Number(process.env["MENTOR_TZ_OFFSET_MINUTES"] ?? 0);
const MENTEE_TZ_OFFSET = Number(process.env["MENTEE_TZ_OFFSET_MINUTES"] ?? 0);

const { db, sqlClient } = createClient(DATABASE_URL);

const [existingOrg] = await db
  .select({ id: organizations.id })
  .from(organizations)
  .where(eq(organizations.id, ORG_ID));

if (!existingOrg) {
  await db.insert(organizations).values({
    id: ORG_ID,
    name: "Live sandbox",
    slug: `live-${ORG_ID.slice(0, 8)}`,
  });
  console.log(`Created org ${ORG_ID}.`);
} else {
  console.log(`Reusing org ${ORG_ID}.`);
}

const programId = randomUUID();
await db.insert(programs).values({
  id: programId,
  orgId: ORG_ID,
  name: "Live-tenant sandbox program",
  policy: defaultPolicy({
    pairing: { mode: "imported" },
    cadence: { everyDays: 14, label: "fortnightly", reminderLeadHours: 24 },
  }),
});

const cohortId = randomUUID();
const now = new Date();
const inSixMonths = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
await db.insert(cohorts).values({
  id: cohortId,
  orgId: ORG_ID,
  programId,
  name: "Sandbox cohort",
  startsAt: now,
  endsAt: inSixMonths,
});

const mentorUserId = randomUUID();
const menteeUserId = randomUUID();
await db.insert(users).values([
  {
    id: mentorUserId,
    orgId: ORG_ID,
    email: MENTOR_EMAIL,
    displayName: MENTOR_NAME,
    tzOffsetMinutes: MENTOR_TZ_OFFSET,
  },
  {
    id: menteeUserId,
    orgId: ORG_ID,
    email: MENTEE_EMAIL,
    displayName: MENTEE_NAME,
    tzOffsetMinutes: MENTEE_TZ_OFFSET,
  },
]);

const [mentor, mentee] = await db
  .insert(participants)
  .values([
    { orgId: ORG_ID, cohortId, userId: mentorUserId, role: "mentor" },
    { orgId: ORG_ID, cohortId, userId: menteeUserId, role: "mentee" },
  ])
  .returning();

await db.insert(identityLinks).values([
  {
    orgId: ORG_ID,
    userId: mentorUserId,
    provider: "slack",
    externalId: MENTOR_SLACK_ID,
    verifiedAt: now,
  },
  {
    orgId: ORG_ID,
    userId: menteeUserId,
    provider: "slack",
    externalId: MENTEE_SLACK_ID,
    verifiedAt: now,
  },
]);

const [pairing] = await db
  .insert(pairings)
  .values({
    orgId: ORG_ID,
    cohortId,
    mentorParticipantId: mentor!.id,
    menteeParticipantId: mentee!.id,
    pairKey: `live|${mentorUserId}|${menteeUserId}|${randomUUID().slice(0, 8)}`,
    state: "active",
    origin: "imported",
  })
  .returning();

// What the roster importer writes when a pair goes active — this is the same
// event, so the worker cannot tell this pair from one that came through a
// spreadsheet (ADR-0003).
const sink = new PostgresEventSink(db);
await sink.emit({
  orgId: ORG_ID,
  name: "pair.activated",
  subjectRef: subjectRef("pairing", pairing!.id),
  payload: { participantIds: [mentor!.id, mentee!.id] },
});

console.log(`
Seeded pairing ${pairing!.id}.

  export ORG_ID=${ORG_ID}

pnpm serve:worker:live will pick up the pair.activated event on its next
pass, open a group DM with both Slack ids, and post a proposal there.
`);

await sqlClient.end();
