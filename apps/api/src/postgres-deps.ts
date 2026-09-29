import type { Db } from "@mentorship/db";
import { PostgresAiRunSink } from "@mentorship/ai/postgres";
import { PostgresMagicLinkStore, PostgresStaffDirectory } from "@mentorship/auth/postgres";
import {
  SlackWebApiModalOpener,
  type SlackTransport,
} from "@mentorship/integrations";
import { PostgresEnrollmentService } from "./postgres-enrollment.js";
import {
  PostgresAgreementResponder,
  PostgresChatIdentityResolver,
  PostgresCounterContextResolver,
  PostgresExtractionResponder,
  PostgresNotesSink,
  PostgresPairingLocator,
  PostgresPairPreferencesStore,
} from "./postgres-ports.js";
import {
  getMatchingRoundCandidates,
  listDeadLetters,
  listOpenRiskFindings,
  listRecentNudges,
  listStuckSagas,
} from "./postgres-reads.js";
import {
  PostgresDocumentSettingsStore,
  PostgresSheetSettingsStore,
} from "./postgres-settings.js";
import type { ApiServerDeps } from "./server.js";

/**
 * The Postgres-backed `ApiServerDeps`, as one function, so the thing the
 * journey suite (`tests/e2e/`) listens on is the thing `main.ts` ships rather
 * than a second, hand-assembled copy that could drift from it. `main.ts` owns
 * reading the environment; this owns the wiring.
 *
 * `slackTransport` is the one Slack call this process makes itself
 * (`views.open`, because a trigger_id expires long before the worker's relay
 * would run an effect). Absent means no bot token: the counter and
 * preferences clicks ack and record themselves as unhandled.
 *
 * `now` exists for the journey suite's fake clock. Production leaves it unset
 * and every port reads the wall clock, which is what it always did.
 */
export interface PostgresApiDepsOptions {
  db: Db;
  orgId: string;
  slackSigningSecret: string;
  role?: string;
  slackTransport?: SlackTransport;
  now?: () => Date;
  onUnhandled?: ApiServerDeps["onUnhandled"];
  onMagicLinkIssued?: (email: string, rawToken: string) => void;
}

export function buildPostgresApiDeps(options: PostgresApiDepsOptions): ApiServerDeps {
  const { db, orgId, role } = options;
  const scoped = role === undefined ? {} : { role };
  const ports = {
    db,
    orgId,
    ...scoped,
    ...(options.now ? { now: options.now } : {}),
  };

  return {
    slackSigningSecret: options.slackSigningSecret,
    identity: new PostgresChatIdentityResolver(ports),
    responder: new PostgresAgreementResponder(ports),
    extractions: new PostgresExtractionResponder(ports, new PostgresAiRunSink(db, scoped)),
    ...(options.slackTransport
      ? (() => {
          const modals = new SlackWebApiModalOpener(options.slackTransport);
          return {
            counterModal: {
              modals,
              counters: new PostgresCounterContextResolver(ports),
            },
            preferences: {
              modals,
              store: new PostgresPairPreferencesStore(ports),
            },
          };
        })()
      : {}),
    slackEvents: {
      locator: new PostgresPairingLocator(ports),
      notes: new PostgresNotesSink(ports),
    },
    ...(options.onUnhandled ? { onUnhandled: options.onUnhandled } : {}),
    ...(options.now ? { now: options.now } : {}),
    admin: {
      riskFindings: (org, limit) => listOpenRiskFindings(db, org, limit, role),
      nudges: (org, limit) => listRecentNudges(db, org, limit, role),
      stuckSagas: (org, limit, olderThanDays) =>
        listStuckSagas(db, org, limit, olderThanDays, role),
      deadLetters: (org, limit) => listDeadLetters(db, org, limit, role),
      matchingRoundCandidates: (org, runId) =>
        getMatchingRoundCandidates(db, org, runId, role),
    },
    documentSettings: new PostgresDocumentSettingsStore(db, scoped),
    sheetSettings: new PostgresSheetSettingsStore(db, scoped),
    enrollment: new PostgresEnrollmentService(db, {
      ...scoped,
      ...(options.now ? { now: options.now } : {}),
    }),
    auth: {
      store: new PostgresMagicLinkStore(db, scoped),
      staff: new PostgresStaffDirectory(db, scoped),
      orgId,
      ...(options.onMagicLinkIssued
        ? { onMagicLinkIssued: options.onMagicLinkIssued }
        : {}),
    },
  };
}
