import {
  FakeDocument,
  FakeTranscript,
  GoogleCalendarAdapter,
  guardAdapter,
  httpGoogleTransport,
  httpSlackTransport,
  IntegrationRegistry,
  Recorder,
  SandboxGuard,
  SlackConversationAdapter,
  SlackDmAdapter,
} from "@mentorship/integrations";

/**
 * The registry for a live-tenant test: real Slack and Google, everything else
 * still fake.
 *
 * Deliberately partial. There is no real transcript or document adapter yet —
 * building one means a Zoom/Meet transcript fetch or a Google Docs write, and
 * neither exists — so binding fakes for those slots is the honest choice
 * rather than a shortcut: it names the boundary of what this actually tests
 * instead of quietly pretending the whole pipeline is live.
 *
 * Every slot that can address a person is wrapped in `SandboxGuard` before it
 * is bound. That happens here and nowhere else, so there is exactly one place
 * a live run could forget it.
 */

export interface LiveEnv {
  SLACK_BOT_TOKEN?: string;
  GOOGLE_ACCESS_TOKEN?: string;
  GOOGLE_CALENDAR_ID?: string;
  SANDBOX_ALLOWLIST?: string;
}

export function buildLiveRegistry(
  env: LiveEnv,
  onRefused?: (detail: { adapter: string; refused: string[] }) => void,
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

  // Not live, and not guarded — they act on artefacts the pair owns, not on a
  // person, which is the same reasoning `guardAdapter`'s default case uses.
  registry.bind(new FakeTranscript(recorder, { autoTranscription: "none" }));
  registry.bind(new FakeDocument(recorder));

  return { registry, recorder };
}
