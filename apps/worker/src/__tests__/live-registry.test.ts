import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarAdapter, ConversationAdapter, DmAdapter } from "@mentorship/core";
import { SandboxRefusal } from "@mentorship/integrations";
import { buildLiveRegistry } from "../live-registry.js";

/**
 * Not a network test — no call ever reaches Slack or Google here, since every
 * check below fails before a request would go out. What matters is that
 * misconfiguration is loud, and that a real Slack/Google adapter — not the
 * fakes — is what ends up guarded.
 */

const FULL_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  GOOGLE_ACCESS_TOKEN: "test-token",
  GOOGLE_CALENDAR_ID: "cal_test",
  SANDBOX_ALLOWLIST: "dhavals+mentor@wekancode.com,U-TEST",
};

describe("buildLiveRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to start with any credential missing", () => {
    for (const key of Object.keys(FULL_ENV) as (keyof typeof FULL_ENV)[]) {
      const env = { ...FULL_ENV, [key]: undefined };
      expect(() => buildLiveRegistry(env)).toThrow(new RegExp(key));
    }
  });

  it("binds a real Slack conversation adapter, not the fake, and guards it", async () => {
    const { registry } = buildLiveRegistry(FULL_ENV);
    const adapter = registry.get<ConversationAdapter>("conversation")!;
    expect(adapter.id).toBe("slack");
    await expect(
      adapter.ensureThread({
        pairingId: "p1",
        memberRefs: ["U-NOT-ALLOWED"],
        title: "x",
      }),
    ).rejects.toBeInstanceOf(SandboxRefusal);
  });

  it("binds a real, guarded Slack DM adapter", async () => {
    const { registry } = buildLiveRegistry(FULL_ENV);
    const adapter = registry.get<DmAdapter>("dm")!;
    expect(adapter.id).toBe("slack");
    await expect(
      adapter.send({
        memberRef: "U-NOT-ALLOWED",
        body: "hi",
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(SandboxRefusal);
  });

  it("binds a real, guarded Google Calendar adapter with sendUpdates off", async () => {
    const { registry } = buildLiveRegistry(FULL_ENV);
    const adapter = registry.get<CalendarAdapter>("calendar")!;
    expect(adapter.id).toBe("google");
    await expect(
      adapter.freeBusy({
        memberRefs: ["not-allowed@example.com"],
        window: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" },
      }),
    ).rejects.toBeInstanceOf(SandboxRefusal);
  });

  it("leaves an allowlisted recipient through the guard, all the way to the transport", async () => {
    // No real network: fetch is stubbed so the only thing under test is
    // whether the guard let the call reach the transport at all.
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { registry } = buildLiveRegistry(FULL_ENV);
    const adapter = registry.get<DmAdapter>("dm")!;
    await expect(
      adapter.send({
        memberRef: "U-TEST",
        body: "hi",
        idempotencyKey: "k",
      }),
    ).resolves.toEqual({ messageRef: "123.456" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("still binds fake transcript, document and sheet, unguarded", () => {
    const { registry } = buildLiveRegistry(FULL_ENV);
    expect(registry.get("transcript")!.id).toBe("fake-transcript");
    expect(registry.get("document")!.id).toBe("fake-doc");
    expect(registry.get("sheet")!.id).toBe("fake-sheet");
  });

  it("binds a real Google Sheets adapter when a sheet config is passed, not guarded", async () => {
    const { registry } = buildLiveRegistry(FULL_ENV, undefined, null, {
      folderId: "folder_1",
    });
    const adapter = registry.get("sheet")!;
    expect(adapter.id).toBe("google-sheets");

    // Not wrapped in SandboxGuard: a call reaches the transport directly
    // rather than throwing SandboxRefusal for an unlisted "recipient" — a
    // spreadsheet folder addresses nobody, so there is nothing to guard.
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ id: "folder_1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect((adapter as { probe(): Promise<unknown> }).probe()).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  describe("vendor fixture capture", () => {
    const dm = async (env: Record<string, string>) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 })),
      );
      const built = buildLiveRegistry(env);
      await built.registry.get<DmAdapter>("dm")!.send({
        memberRef: "U-TEST",
        body: "hi",
        idempotencyKey: "k",
      });
      return built;
    };

    it("is off by default: nothing is written", async () => {
      const dir = mkdtempSync(join(tmpdir(), "capture-off-"));
      try {
        const built = await dm({ ...FULL_ENV, VENDOR_FIXTURE_DIR: dir });
        expect(built.capturedFixtures).toEqual([]);
        expect(existsSync(join(dir, "slack"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("with CAPTURE_VENDOR_FIXTURES=1, writes a redacted live fixture under the guard", async () => {
      const dir = mkdtempSync(join(tmpdir(), "capture-on-"));
      try {
        const built = await dm({ ...FULL_ENV, CAPTURE_VENDOR_FIXTURES: "1", VENDOR_FIXTURE_DIR: dir });
        expect(built.capturedFixtures).toEqual([join(dir, "slack", "chat.postMessage.json")]);
        const written = readFileSync(built.capturedFixtures[0]!, "utf8");
        expect(JSON.parse(written)).toMatchObject({ source: "live", call: "chat.postMessage" });
        expect(written).not.toContain("xoxb-test");

        // A refused recipient never reaches the transport, so nothing new is recorded.
        await expect(
          built.registry.get<DmAdapter>("dm")!.send({ memberRef: "U-NOPE", body: "x", idempotencyKey: "k2" }),
        ).rejects.toBeInstanceOf(SandboxRefusal);
        expect(built.capturedFixtures).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Google refresh-token credentials", () => {
    const REFRESH_ENV = {
      SLACK_BOT_TOKEN: "xoxb-test",
      GOOGLE_CLIENT_ID: "client-1",
      GOOGLE_CLIENT_SECRET: "secret-1",
      GOOGLE_REFRESH_TOKEN: "refresh-1",
      GOOGLE_CALENDAR_ID: "cal_test",
      SANDBOX_ALLOWLIST: "dhavals+mentor@wekancode.com,U-TEST",
    };

    it("starts fine with the three refresh vars and no static access token", () => {
      expect(() => buildLiveRegistry(REFRESH_ENV)).not.toThrow();
      const { registry } = buildLiveRegistry(REFRESH_ENV);
      expect(registry.get("calendar")!.id).toBe("google");
    });

    it("still refuses to start when neither credential path is complete", () => {
      const { GOOGLE_CLIENT_ID: _drop, ...partial } = REFRESH_ENV;
      expect(() => buildLiveRegistry(partial)).toThrow(/GOOGLE_ACCESS_TOKEN/);
    });

    it("mints an access token from the refresh credentials on first real call", async () => {
      const fetchSpy = vi.fn(async (url: string | URL, _init?: RequestInit) => {
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "minted-token", expires_in: 3600 }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ calendars: {} }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const { registry } = buildLiveRegistry(REFRESH_ENV);
      const adapter = registry.get<CalendarAdapter>("calendar")!;
      await adapter.freeBusy({
        memberRefs: [],
        window: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" },
      });

      const tokenCall = fetchSpy.mock.calls.find(
        ([url]) => String(url) === "https://oauth2.googleapis.com/token",
      );
      expect(tokenCall).toBeDefined();
      const [calendarUrl, calendarInit] = fetchSpy.mock.calls.find(
        ([url]) => String(url) !== "https://oauth2.googleapis.com/token",
      )!;
      expect(String(calendarUrl)).toContain("googleapis.com/calendar");
      expect((calendarInit!.headers as Record<string, string>)["authorization"]).toBe(
        "Bearer minted-token",
      );
    });
  });
});
