import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeStaffDirectory } from "./staff-fake.js";
import type { MagicLinkStore } from "@mentorship/auth";
import {
  createServer,
  type SheetSettings,
  type SheetSettingsStore,
} from "../server.js";

/**
 * Mirrors `document-settings.test.ts` exactly — same real-socket, real-cookie
 * shape, same thing under test: the write route is gated exactly as hard as
 * the read route, and a session belonging to another org can do neither.
 */

const VALID_ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222";

class FakeMagicLinkStore implements MagicLinkStore {
  private sessions = new Map<string, { orgId: string; userId: string }>();
  private next = 1;

  seedSession(orgId: string, userId: string): string {
    const sessionId = `sess-${this.next++}`;
    this.sessions.set(sessionId, { orgId, userId });
    return sessionId;
  }

  async findUserByEmail() {
    return null;
  }
  async createLink(): Promise<void> {}
  async findUnconsumedLinkByTokenHash() {
    return null;
  }
  async consumeLink(): Promise<boolean> {
    return false;
  }
  async createSession(input: { orgId: string; userId: string }) {
    return { sessionId: this.seedSession(input.orgId, input.userId) };
  }
  async findActiveSession(orgId: string, sessionId: string) {
    const row = this.sessions.get(sessionId);
    if (!row || row.orgId !== orgId) return null;
    return {
      userId: row.userId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    };
  }
}

class FakeSettingsStore implements SheetSettingsStore {
  written: SheetSettings[] = [];
  current: SheetSettings = { folderId: null, spreadsheetId: null };

  async read(): Promise<SheetSettings> {
    return this.current;
  }
  async write(_orgId: string, settings: SheetSettings): Promise<void> {
    this.written.push(settings);
    this.current = settings;
  }
}

describe("sheet settings route", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(sheetSettings?: SheetSettingsStore): Promise<{
    base: string;
    store: FakeMagicLinkStore;
  }> {
    const store = new FakeMagicLinkStore();
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: { resolveParticipantId: async () => null },
      responder: { respond: async () => {} },
      auth: { store, staff: new FakeStaffDirectory("admin"), orgId: VALID_ORG_ID },
      ...(sheetSettings ? { sheetSettings } : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, store };
  }

  function cookieFor(store: FakeMagicLinkStore): string {
    return `mentorship_session=${store.seedSession(VALID_ORG_ID, "user-1")}`;
  }

  function put(base: string, cookie: string, body: unknown): Promise<Response> {
    return fetch(`${base}/orgs/${VALID_ORG_ID}/settings/sheet`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns the stored settings", async () => {
    const settings = new FakeSettingsStore();
    settings.current = { folderId: "F1", spreadsheetId: "S1" };
    const { base, store } = await listen(settings);

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/settings/sheet`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(settings.current);
  });

  it("extracts ids from pasted URLs", async () => {
    const settings = new FakeSettingsStore();
    const { base, store } = await listen(settings);

    const res = await put(base, cookieFor(store), {
      folder: "https://drive.google.com/drive/folders/FOLDER_1?usp=sharing",
      spreadsheet: "https://docs.google.com/spreadsheets/d/SHEET_1/edit#gid=0",
    });

    expect(res.status).toBe(200);
    expect(settings.written).toEqual([
      { folderId: "FOLDER_1", spreadsheetId: "SHEET_1" },
    ]);
  });

  it("accepts bare ids and an omitted spreadsheet", async () => {
    const settings = new FakeSettingsStore();
    const { base, store } = await listen(settings);

    const res = await put(base, cookieFor(store), { folder: "FOLDER_1" });

    expect(res.status).toBe(200);
    expect(settings.written[0]).toEqual({ folderId: "FOLDER_1", spreadsheetId: null });
  });

  it("400s an unusable folder without writing anything", async () => {
    const settings = new FakeSettingsStore();
    const { base, store } = await listen(settings);

    const res = await put(base, cookieFor(store), { folder: "not a folder url" });
    expect(res.status).toBe(400);
    expect(settings.written).toEqual([]);
  });

  it("400s an unusable spreadsheet without writing anything", async () => {
    const settings = new FakeSettingsStore();
    const { base, store } = await listen(settings);

    const res = await put(base, cookieFor(store), {
      folder: "FOLDER_1",
      spreadsheet: "https://example.com/not-a-sheet",
    });
    expect(res.status).toBe(400);
    expect(settings.written).toEqual([]);
  });

  it("401s an unauthenticated write without touching the store", async () => {
    const settings = new FakeSettingsStore();
    const { base } = await listen(settings);

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/settings/sheet`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "FOLDER_1" }),
    });
    expect(res.status).toBe(401);
    expect(settings.written).toEqual([]);
  });

  it("403s a session belonging to another org", async () => {
    const settings = new FakeSettingsStore();
    const { base, store } = await listen(settings);

    const res = await fetch(`${base}/orgs/${OTHER_ORG_ID}/settings/sheet`, {
      method: "PUT",
      headers: { cookie: cookieFor(store), "content-type": "application/json" },
      body: JSON.stringify({ folder: "FOLDER_1" }),
    });
    expect(res.status).toBe(403);
    expect(settings.written).toEqual([]);
  });

  it("501s when no settings store is configured", async () => {
    const { base, store } = await listen(undefined);
    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/settings/sheet`, {
      headers: { cookie: cookieFor(store) },
    });
    expect(res.status).toBe(501);
  });
});
