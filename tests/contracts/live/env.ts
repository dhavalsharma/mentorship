/**
 * What the live vendor contract suite needs before it will touch anything.
 *
 * The suite talks to a real Slack workspace and a real Google account, so the
 * bar for starting is deliberately higher than `buildLiveRegistry`'s own:
 * besides credentials, `SANDBOX_ALLOWLIST` must name at least two Slack
 * members (a pair's group DM needs two) and at least one email (the calendar
 * attendee and the Drive share), because every person-addressing call is
 * routed through `SandboxGuard` and an allowlist with nobody on it would just
 * turn the whole run into refusals. See docs/vendor-contracts.md and
 * docs/live-tenant-testing.md before setting any of this.
 */

export interface LiveContractEnv {
  SLACK_BOT_TOKEN: string;
  SANDBOX_ALLOWLIST: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_DRIVE_FOLDER_ID: string;
  GOOGLE_SHEETS_FOLDER_ID?: string;
  GOOGLE_ACCESS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  VENDOR_FIXTURE_DIR?: string;
  slackMembers: string[];
  emails: string[];
}

export function checkLiveContractEnv(
  env: Record<string, string | undefined>,
): { ok: true; env: LiveContractEnv } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const key of ["SLACK_BOT_TOKEN", "SANDBOX_ALLOWLIST", "GOOGLE_CALENDAR_ID", "GOOGLE_DRIVE_FOLDER_ID"]) {
    if (!env[key]?.trim()) missing.push(key);
  }
  const refresh = !!env["GOOGLE_CLIENT_ID"] && !!env["GOOGLE_CLIENT_SECRET"] && !!env["GOOGLE_REFRESH_TOKEN"];
  if (!env["GOOGLE_ACCESS_TOKEN"] && !refresh) {
    missing.push("GOOGLE_ACCESS_TOKEN (or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)");
  }

  const allowlist = (env["SANDBOX_ALLOWLIST"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const slackMembers = allowlist.filter((e) => /^[UW][A-Z0-9]+$/.test(e));
  const emails = allowlist.filter((e) => e.includes("@"));
  if (env["SANDBOX_ALLOWLIST"]?.trim()) {
    if (slackMembers.length < 2) missing.push("SANDBOX_ALLOWLIST with at least two Slack member ids (U…)");
    if (emails.length < 1) missing.push("SANDBOX_ALLOWLIST with at least one email");
  }

  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    env: {
      ...(Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined),
      ) as unknown as LiveContractEnv),
      slackMembers,
      emails,
    },
  };
}

/** For the suite files: the same refusal, as a throw at import time. */
export function requireLiveContractEnv(): LiveContractEnv {
  const checked = checkLiveContractEnv(process.env);
  if (!checked.ok) {
    throw new Error(
      `live vendor contracts refused to run — missing: ${checked.missing.join("; ")}. ` +
        "See docs/vendor-contracts.md.",
    );
  }
  return checked.env;
}
