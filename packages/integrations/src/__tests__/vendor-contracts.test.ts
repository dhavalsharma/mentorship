import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyGoogle,
  classifySlack,
  ContractDriftError,
  fileFixtureSink,
  fixtureStaleness,
  knownGoogleCalls,
  loadVendorFixtures,
  memoryFixtureSink,
  MissingFixtureError,
  recordingGoogleDocsTransport,
  recordingSlackTransport,
  redact,
  REDACTED,
  SlackDmAdapter,
  VendorReplay,
  type SlackTransport,
} from "@mentorship/integrations";
import { maxFixtureAgeDays, vendorFixtures } from "./vendor-replay.js";

/**
 * The fixture machinery itself (tier 4): the checked-in directory is
 * well-formed and complete, capture redacts what must never be committed, and
 * the replay's drift checks actually bite.
 */

describe("tests/fixtures/vendor", () => {
  const fixtures = vendorFixtures();

  it("loads, and every fixture's recorded route classifies back to its own call", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const classified =
        f.vendor === "slack"
          ? classifySlack(f.request.path, (f.request.body ?? {}) as Record<string, unknown>)
          : classifyGoogle({
              method: f.request.method,
              path: f.request.path,
              ...(f.request.api ? { api: f.request.api } : {}),
              ...(f.request.query ? { query: f.request.query } : {}),
            });
      expect(classified, `${f.vendor}/${f.call}`).not.toBeNull();
      expect(classified!.call).toBe(f.call);
      expect(classified!.vendor).toBe(f.vendor);
    }
  });

  it("has a fixture for every Google route an adapter can call", () => {
    const have = new Set(fixtures.map((f) => `${f.vendor}/${f.call}`));
    const missing = knownGoogleCalls()
      .map((c) => `${c.vendor}/${c.call}`)
      .filter((c) => !have.has(c));
    expect(missing).toEqual([]);
  });

  it("names every hand-written or stale fixture — a warning, never a failure", () => {
    const stale = fixtures
      .map((f) => ({ f, s: fixtureStaleness(f, { maxAgeDays: maxFixtureAgeDays() }) }))
      .filter(({ s }) => s.stale);
    if (stale.length > 0) {
      console.warn(
        `[vendor-fixtures] ${stale.length}/${fixtures.length} fixtures are unverified against the live API ` +
          "(see docs/vendor-contracts.md):\n" +
          stale
            .map(({ f, s }) => `  ${f.vendor}/${f.call}${f.variant ? `--${f.variant}` : ""}: ${s.reasons.join("; ")}`)
            .join("\n"),
      );
    }
    expect(true).toBe(true);
  });
});

describe("fixtureStaleness", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("flags hand-written regardless of age", () => {
    expect(fixtureStaleness({ source: "hand-written", capturedOn: "2026-09-23" }, { now }).stale).toBe(true);
  });
  it("flags a live capture older than the limit, and not a fresh one", () => {
    expect(fixtureStaleness({ source: "live", capturedOn: "2026-01-01" }, { now, maxAgeDays: 90 })).toMatchObject({
      stale: true,
      reasons: [expect.stringMatching(/days old/)],
    });
    expect(fixtureStaleness({ source: "live", capturedOn: "2026-09-01" }, { now, maxAgeDays: 90 }).stale).toBe(false);
  });
});

describe("redact", () => {
  it("removes tokens, secrets and emails, keeping shape and the plus-address flag", () => {
    const out = redact({
      access_token: "ya29.abc",
      nested: { client_secret: "shh", note: "Bearer ya29.xyz-123 was used" },
      attendees: [{ email: "Priya@Corp.com" }, { email: "sam+mentor@corp.com" }, { email: "priya@corp.com" }],
      message: "slack failed with xoxb-123-456-abc",
      user_id: "U0123ABCDEF",
      nextPageToken: "page-2",
    });
    expect(out.access_token).toBe(REDACTED);
    expect(out.nested.client_secret).toBe(REDACTED);
    expect(out.nested.note).not.toMatch(/ya29/);
    expect(out.message).not.toMatch(/xoxb/);
    expect(out.attendees).toEqual([
      { email: "user1@example.com" },
      { email: "user2+tag@example.com" },
      // Same person, same replacement: two attendees stay two, not three.
      { email: "user1@example.com" },
    ]);
    expect(out.user_id).toMatch(/^UREDACTED/);
    // A pagination cursor is not a credential.
    expect(out.nextPageToken).toBe("page-2");
  });
});

describe("recordingTransport", () => {
  const now = () => new Date("2026-09-23T10:00:00Z");
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes a dated, live, redacted fixture per call and returns the real response untouched", async () => {
    const sink = memoryFixtureSink();
    const inner: SlackTransport = async () => ({ ok: true, ts: "1.2", user: "U0123ABCDEF" });
    const call = recordingSlackTransport(inner, { sink, now });

    const res = await new SlackDmAdapter(call).send({
      memberRef: "U0123ABCDEF",
      body: "reach me at priya@corp.com",
      idempotencyKey: "k",
    });

    expect(res).toEqual({ messageRef: "1.2" });
    expect(sink.fixtures).toHaveLength(1);
    const [f] = sink.fixtures;
    expect(f).toMatchObject({
      vendor: "slack",
      call: "chat.postMessage",
      capturedOn: "2026-09-23",
      source: "live",
    });
    expect(JSON.stringify(f)).not.toMatch(/priya@corp\.com|U0123ABCDEF/);
  });

  it("records a thrown vendor error as an error variant, redacted, and still throws it", async () => {
    const sink = memoryFixtureSink();
    const call = recordingGoogleDocsTransport(
      async () => {
        throw new Error('google drive failed for sam+mentor@corp.com: {"reason":"invalidSharingRequest"}');
      },
      { sink, now },
    );
    await expect(
      call("drive", "/files/doc_1/permissions", { method: "POST", body: { emailAddress: "sam+mentor@corp.com" } }),
    ).rejects.toThrow(/invalidSharingRequest/);
    expect(sink.fixtures[0]).toMatchObject({
      vendor: "google-drive",
      call: "permissions.create",
      variant: "error",
      request: { path: "/files/{fileId}/permissions" },
    });
    expect(sink.fixtures[0]!.error!.message).toMatch(/user1\+tag@example\.com/);
  });

  it("never lets a failed write break the live call it describes", async () => {
    const warnings: string[] = [];
    const call = recordingSlackTransport(async () => ({ ok: true, ts: "9.9" }), {
      sink: {
        write() {
          throw new Error("disk full");
        },
      },
      onWarn: (m) => warnings.push(m),
    });
    await expect(call("chat.postMessage", { channel: "C1", text: "x" })).resolves.toMatchObject({ ts: "9.9" });
    expect(warnings).toEqual(["vendor fixture capture failed"]);
  });

  it("round-trips: what the file sink writes, the loader reads and the replay serves", async () => {
    dir = mkdtempSync(join(tmpdir(), "vendor-fixtures-"));
    const sink = fileFixtureSink(dir);
    const call = recordingSlackTransport(async () => ({ ok: true, ts: "5.5" }), { sink, now });
    await call("chat.postMessage", { channel: "C1", text: "hello" });

    expect(sink.written).toEqual([join(dir, "slack", "chat.postMessage.json")]);
    expect(JSON.parse(readFileSync(sink.written[0]!, "utf8"))).toMatchObject({ source: "live" });

    const replay = new VendorReplay(loadVendorFixtures(dir));
    const res = await new SlackDmAdapter(replay.slack()).send({ memberRef: "C1", body: "hello", idempotencyKey: "k" });
    expect(res).toEqual({ messageRef: "5.5" });
    expect(replay.staleServed({ now: now() })).toEqual([]);
  });
});

describe("VendorReplay drift checks", () => {
  const fixtures = vendorFixtures();

  it("refuses a query parameter no fixture has recorded", async () => {
    const call = new VendorReplay(fixtures).googleDocs();
    await expect(
      call("drive", "/files/folder_1", { method: "GET", query: { fields: "id", includeLabels: "x" } }),
    ).rejects.toBeInstanceOf(ContractDriftError);
  });

  it("refuses a body field no fixture has recorded", async () => {
    const call = new VendorReplay(fixtures).slack();
    await expect(
      call("chat.postMessage", { channel: "C1", text: "x", unfurl_links: false }),
    ).rejects.toBeInstanceOf(ContractDriftError);
  });

  it("refuses a handler that invents a response field", async () => {
    const replay = new VendorReplay(fixtures).on("files.copy", ({ response }) => ({
      ...response,
      webViewLink: "https://invented",
    }));
    await expect(
      replay.googleDocs()("drive", "/files/g/copy", { method: "POST", query: { fields: "id" }, body: { name: "n" } }),
    ).rejects.toThrow(/webViewLink/);
  });

  it("refuses a call nobody has a fixture for", async () => {
    const call = new VendorReplay(fixtures).slack();
    await expect(call("reactions.add", { channel: "C1" })).rejects.toBeInstanceOf(MissingFixtureError);
    const google = new VendorReplay(fixtures).googleDocs();
    await expect(google("drive", "/about", { method: "GET" })).rejects.toBeInstanceOf(MissingFixtureError);
  });
});
