import { fileURLToPath } from "node:url";
import {
  fileFixtureSink,
  FakeDocument,
  FakeSheet,
  FakeTranscript,
  GoogleCalendarAdapter,
  GoogleDriveDocumentAdapter,
  GoogleSheetsAdapter,
  guardAdapter,
  httpGoogleDocsTransport,
  httpGoogleSheetsTransport,
  httpGoogleTransport,
  httpSlackTransport,
  IntegrationRegistry,
  recordingGoogleDocsTransport,
  recordingGoogleSheetsTransport,
  recordingGoogleTransport,
  recordingSlackTransport,
  Recorder,
  refreshableGoogleAccessToken,
  SandboxGuard,
  SlackConversationAdapter,
  SlackDmAdapter,
  staticAccessToken,
  type GoogleAccessTokenSource,
  type GoogleDocsTransport,
  type GoogleDriveDocumentConfig,
  type GoogleSheetConfig,
  type GoogleSheetsTransport,
  type GoogleTransport,
  type RecordingOptions,
  type SlackTransport,
} from "@mentorship/integrations";
import { documentConfigFromEnv, type DocumentEnv } from "./document-config.js";
import { sheetConfigFromEnv, type SheetEnv } from "./reports.js";

/**
 * The registry for a live-tenant test: real Slack and Google, everything else
 * still fake.
 *
 * Still partial. There is no real transcript adapter — that means a Zoom/Meet
 * transcript fetch, which does not exist — so a fake is bound for that slot:
 * it names the boundary of what this actually tests instead of quietly
 * pretending the whole pipeline is live. The document slot now has a real
 * adapter, bound only when a Drive folder is configured.
 *
 * Every slot that can address a person is wrapped in `SandboxGuard` before it
 * is bound. That happens here and nowhere else, so there is exactly one place
 * a live run could forget it.
 */

export interface LiveEnv extends DocumentEnv, SheetEnv {
  SLACK_BOT_TOKEN?: string | undefined;
  /**
   * A one-off access token — the simplest path, and the one that expires in
   * about an hour with no way back except redoing the OAuth exchange by
   * hand. Prefer the three `GOOGLE_CLIENT_*`/`GOOGLE_REFRESH_TOKEN` vars
   * below for anything longer than a quick test; see `./auth.ts`.
   */
  GOOGLE_ACCESS_TOKEN?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_REFRESH_TOKEN?: string | undefined;
  GOOGLE_CALENDAR_ID?: string | undefined;
  SANDBOX_ALLOWLIST?: string | undefined;
  /**
   * `1` turns on vendor fixture capture (docs/vendor-contracts.md): every
   * Slack and Google request/response this registry's transports carry is
   * written, redacted, to `VENDOR_FIXTURE_DIR`. Off unless set — capture
   * changes nothing about what is sent, but it does write files.
   */
  CAPTURE_VENDOR_FIXTURES?: string | undefined;
  /** Defaults to the repo's `tests/fixtures/vendor`. */
  VENDOR_FIXTURE_DIR?: string | undefined;
}

/** The raw transports under the adapters — already capture-wrapped when capture is on. */
export interface LiveTransports {
  slack: SlackTransport;
  googleCalendar: GoogleTransport;
  googleDocs: GoogleDocsTransport;
  googleSheets: GoogleSheetsTransport;
}

export const DEFAULT_VENDOR_FIXTURE_DIR = fileURLToPath(
  new URL("../../../tests/fixtures/vendor", import.meta.url),
);

export function buildLiveRegistry(
  env: LiveEnv,
  onRefused?: (detail: { adapter: string; refused: string[] }) => void,
  /**
   * A config already resolved from `integration_bindings`, which outranks the
   * environment. Passed in rather than read here so this function stays
   * database-free and synchronous — the same reason the registry knows
   * nothing about `db` anywhere else.
   */
  documentConfig?: GoogleDriveDocumentConfig | null,
  /** Same "already resolved, outranks the environment" reasoning, for the `sheet` slot. */
  sheetConfig?: GoogleSheetConfig | null,
): {
  registry: IntegrationRegistry;
  recorder: Recorder;
  transports: LiveTransports;
  /** Files written by fixture capture so far; empty and unused when capture is off. */
  capturedFixtures: string[];
} {
  const missing: string[] = (
    ["SLACK_BOT_TOKEN", "GOOGLE_CALENDAR_ID", "SANDBOX_ALLOWLIST"] as const
  ).filter((key) => !env[key]);
  const hasRefreshCreds =
    !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && !!env.GOOGLE_REFRESH_TOKEN;
  if (!env.GOOGLE_ACCESS_TOKEN && !hasRefreshCreds) {
    missing.push(
      "GOOGLE_ACCESS_TOKEN (or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)",
    );
  }
  if (missing.length > 0) {
    throw new Error(`live mode needs ${missing.join(", ")} — see .env.example`);
  }

  const allowlist = env.SANDBOX_ALLOWLIST!.split(",").map((s) => s.trim());
  const guard = new SandboxGuard({ allowlist, ...(onRefused ? { onRefused } : {}) });

  const recorder = new Recorder();
  const registry = new IntegrationRegistry();

  // Capture wraps the transport, under the adapter — and so under the guard
  // wrapped around the adapter below: a refused recipient throws before any
  // request exists to record.
  const sink = env.CAPTURE_VENDOR_FIXTURES === "1"
    ? fileFixtureSink(env.VENDOR_FIXTURE_DIR ?? DEFAULT_VENDOR_FIXTURE_DIR)
    : null;
  const recording: RecordingOptions | null = sink
    ? {
        sink,
        onWarn: (message, detail) => console.warn(`[capture] ${message}`, detail ?? ""),
      }
    : null;

  const slackCall = recording
    ? recordingSlackTransport(httpSlackTransport(env.SLACK_BOT_TOKEN!), recording)
    : httpSlackTransport(env.SLACK_BOT_TOKEN!);
  registry.bind(guardAdapter(new SlackConversationAdapter(slackCall), guard));
  registry.bind(guardAdapter(new SlackDmAdapter(slackCall), guard));

  // Shared by both Google transports, so a refresh triggered by a calendar
  // call is reused by the very next Docs call rather than each transport
  // maintaining its own, independently-expiring cache.
  const googleToken: GoogleAccessTokenSource = hasRefreshCreds
    ? refreshableGoogleAccessToken({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        refreshToken: env.GOOGLE_REFRESH_TOKEN!,
      })
    : staticAccessToken(env.GOOGLE_ACCESS_TOKEN!);

  const googleCall = recording
    ? recordingGoogleTransport(httpGoogleTransport(googleToken), recording)
    : httpGoogleTransport(googleToken);
  const docsCall = recording
    ? recordingGoogleDocsTransport(httpGoogleDocsTransport(googleToken), recording)
    : httpGoogleDocsTransport(googleToken);
  const sheetsCall = recording
    ? recordingGoogleSheetsTransport(httpGoogleSheetsTransport(googleToken), recording)
    : httpGoogleSheetsTransport(googleToken);
  registry.bind(
    guardAdapter(
      new GoogleCalendarAdapter(googleCall, {
        calendarId: env.GOOGLE_CALENDAR_ID!,
        // The irreversible bit, off: create the event, read it back, mail no
        // one. See docs/live-tenant-testing.md before ever setting this to
        // anything else.
        sendUpdates: "none",
        transcriptEntitlement: "none",
      }),
      guard,
    ),
  );

  // Not live, and not guarded — it acts on an artefact the pair owns, not on a
  // person, which is the same reasoning `guardAdapter`'s default case uses.
  registry.bind(new FakeTranscript(recorder, { autoTranscription: "none" }));

  // Not guarded either, for that same reason: creating a file in a folder the
  // admin nominated addresses nobody. `SandboxGuard`'s job is to stop a test
  // run putting a message or an invite in front of a real participant, and a
  // Drive write does neither — it is bounded by `folderId` instead, which is
  // the allowlist for this slot.
  const docConfig = documentConfig ?? documentConfigFromEnv(env);
  registry.bind(
    docConfig
      ? new GoogleDriveDocumentAdapter(
          docsCall,
          docConfig,
          // A participant silently missing from their own doc is exactly the
          // kind of gap a live run is meant to surface, so the adapter's skip
          // path is given somewhere to say so.
          (message, detail) => console.warn(`[warn] ${message}`, detail ?? ""),
        )
      : new FakeDocument(recorder),
  );

  // Not guarded, for the same reason the document adapter above is not:
  // `SandboxGuard`'s job is stopping a test run from putting a message or an
  // invite in front of a real *person*, and a report-sync spreadsheet
  // addresses a folder, not a participant — it is bounded by `folderId`
  // (the config the admin nominated), which plays the allowlist's role for
  // this slot the same way it does for `document`. Verified by rereading
  // `GoogleDriveDocumentAdapter`'s own binding above rather than assumed by
  // analogy: neither adapter sends anything to a chat member or a mentor's
  // inbox, they both only write to a Drive artifact the org already owns.
  const sheetCfg = sheetConfig ?? sheetConfigFromEnv(env);
  registry.bind(
    sheetCfg
      ? new GoogleSheetsAdapter(sheetsCall, sheetCfg, (message, detail) =>
          console.warn(`[warn] ${message}`, detail ?? ""),
        )
      : new FakeSheet(recorder),
  );

  return {
    registry,
    recorder,
    transports: {
      slack: slackCall,
      googleCalendar: googleCall,
      googleDocs: docsCall,
      googleSheets: sheetsCall,
    },
    capturedFixtures: sink?.written ?? [],
  };
}
