import {
  FakeDocument,
  FakeTranscript,
  GoogleCalendarAdapter,
  GoogleDriveDocumentAdapter,
  guardAdapter,
  httpGoogleDocsTransport,
  httpGoogleTransport,
  httpSlackTransport,
  IntegrationRegistry,
  Recorder,
  SandboxGuard,
  SlackConversationAdapter,
  SlackDmAdapter,
  type GoogleDriveDocumentConfig,
} from "@mentorship/integrations";
import { documentConfigFromEnv, type DocumentEnv } from "./document-config.js";

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

export interface LiveEnv extends DocumentEnv {
  SLACK_BOT_TOKEN?: string | undefined;
  GOOGLE_ACCESS_TOKEN?: string | undefined;
  GOOGLE_CALENDAR_ID?: string | undefined;
  SANDBOX_ALLOWLIST?: string | undefined;
}

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
): { registry: IntegrationRegistry; recorder: Recorder } {
  const missing = (
    ["SLACK_BOT_TOKEN", "GOOGLE_ACCESS_TOKEN", "GOOGLE_CALENDAR_ID", "SANDBOX_ALLOWLIST"] as const
  ).filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`live mode needs ${missing.join(", ")} — see .env.example`);
  }

  const allowlist = env.SANDBOX_ALLOWLIST!.split(",").map((s) => s.trim());
  const guard = new SandboxGuard({ allowlist, ...(onRefused ? { onRefused } : {}) });

  const recorder = new Recorder();
  const registry = new IntegrationRegistry();

  const slackCall = httpSlackTransport(env.SLACK_BOT_TOKEN!);
  registry.bind(guardAdapter(new SlackConversationAdapter(slackCall), guard));
  registry.bind(guardAdapter(new SlackDmAdapter(slackCall), guard));

  const googleCall = httpGoogleTransport(env.GOOGLE_ACCESS_TOKEN!);
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
          httpGoogleDocsTransport(env.GOOGLE_ACCESS_TOKEN!),
          docConfig,
        )
      : new FakeDocument(recorder),
  );

  return { registry, recorder };
}
