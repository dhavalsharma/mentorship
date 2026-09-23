import { describe, expect, it } from "vitest";
import { checkLiveContractEnv } from "./live/env.js";

/**
 * The live contract suite itself never runs here — only the door in front of
 * it. What must hold: with nothing set it refuses, naming every missing
 * piece; an allowlist too thin to guard a real pair is refused too.
 */

const FULL = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SANDBOX_ALLOWLIST: "U0AAAAAAA1,U0AAAAAAA2,someone@example.com",
  GOOGLE_CALENDAR_ID: "cal",
  GOOGLE_DRIVE_FOLDER_ID: "folder",
  GOOGLE_ACCESS_TOKEN: "t",
};

describe("checkLiveContractEnv", () => {
  it("refuses an empty environment and names everything it needs", () => {
    const checked = checkLiveContractEnv({});
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.missing.join("\n")).toMatch(/SLACK_BOT_TOKEN/);
    expect(checked.missing.join("\n")).toMatch(/SANDBOX_ALLOWLIST/);
    expect(checked.missing.join("\n")).toMatch(/GOOGLE_CALENDAR_ID/);
    expect(checked.missing.join("\n")).toMatch(/GOOGLE_DRIVE_FOLDER_ID/);
    expect(checked.missing.join("\n")).toMatch(/GOOGLE_ACCESS_TOKEN/);
  });

  it("refuses credentials without a usable allowlist", () => {
    const checked = checkLiveContractEnv({ ...FULL, SANDBOX_ALLOWLIST: "someone@example.com" });
    expect(checked).toMatchObject({ ok: false, missing: [expect.stringMatching(/two Slack member ids/)] });
  });

  it("accepts a complete environment, with the refresh-token path as an alternative", () => {
    expect(checkLiveContractEnv(FULL)).toMatchObject({ ok: true, env: { slackMembers: ["U0AAAAAAA1", "U0AAAAAAA2"] } });
    const { GOOGLE_ACCESS_TOKEN: _drop, ...rest } = FULL;
    expect(
      checkLiveContractEnv({ ...rest, GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_REFRESH_TOKEN: "c" }).ok,
    ).toBe(true);
  });
});
