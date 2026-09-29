import { describe, expect, it } from "vitest";
import {
  EmailHeaderInjectionError,
  FakeEmail,
  GmailEmailAdapter,
  guardEmailSender,
  Recorder,
  SandboxGuard,
  SandboxRefusal,
  recordingGoogleGmailTransport,
  memoryFixtureSink,
  GMAIL_RAW_PLACEHOLDER,
} from "@mentorship/integrations";
import { openReplay, warnOnStaleFixtures } from "./vendor-replay.js";

/**
 * No network: the transport replays `tests/fixtures/vendor/google-gmail`, which
 * refuses a body field no fixture recorded. What is proved here is what the
 * adapter *sends* — one `raw` field holding a well-formed message — and how it
 * behaves around Gmail's lack of an idempotency key.
 */

warnOnStaleFixtures("google-gmail.test.ts");

const config = { senderAddress: "noreply@example.org", senderName: "Mentorship" };
const message = {
  to: "priya@example.com",
  subject: "Your sign-in link",
  text: "Follow https://app.example.org/verify?token=abc",
  html: "<p>hi</p>",
};

function decodeRaw(body: unknown): string {
  return Buffer.from((body as { raw: string }).raw, "base64url").toString("utf8");
}

describe("GmailEmailAdapter", () => {
  it("posts one base64url message to users/me/messages/send and returns Gmail's id", async () => {
    const replay = openReplay();
    const adapter = new GmailEmailAdapter(replay.googleGmail(), config, () => new Date("2026-09-29T10:00:00Z"));

    const out = await adapter.send({ ...message, idempotencyKey: "k1" });

    expect(out).toEqual({ messageRef: "MESSAGE_ID" });
    expect(replay.calls).toHaveLength(1);
    const call = replay.calls[0]!;
    expect(call).toMatchObject({ call: "messages.send", method: "POST", path: "/users/me/messages/send" });
    const raw = decodeRaw(call.body);
    expect(raw).toContain('From: "Mentorship" <noreply@example.org>');
    expect(raw).toContain("To: priya@example.com");
    expect(raw).toMatch(/Message-ID: <[0-9a-f]{32}@example\.org>/);
  });

  it("is a no-op for a key it already sent in this process — the only dedupe Gmail allows", async () => {
    const replay = openReplay();
    const adapter = new GmailEmailAdapter(replay.googleGmail(), config);
    await adapter.send({ ...message, idempotencyKey: "same" });
    const again = await adapter.send({ ...message, idempotencyKey: "same" });
    expect(again).toEqual({ messageRef: "MESSAGE_ID" });
    expect(replay.calls).toHaveLength(1);
  });

  it("does NOT dedupe across instances (a restart forgets) — documented, not hidden", async () => {
    const replay = openReplay();
    await new GmailEmailAdapter(replay.googleGmail(), config).send({ ...message, idempotencyKey: "same" });
    await new GmailEmailAdapter(replay.googleGmail(), config).send({ ...message, idempotencyKey: "same" });
    expect(replay.calls).toHaveLength(2);
  });

  it("derives the same Message-ID from the same key", async () => {
    const replay = openReplay();
    const adapter = () => new GmailEmailAdapter(replay.googleGmail(), config);
    await adapter().send({ ...message, idempotencyKey: "same" });
    await adapter().send({ ...message, idempotencyKey: "same" });
    const ids = replay.calls.map((c) => /Message-ID: (<[^>]+>)/.exec(decodeRaw(c.body))![1]);
    expect(ids[0]).toBe(ids[1]);
  });

  it("does not retry and does not remember a failed send", async () => {
    const replay = openReplay().use("messages.send", "error-insufficient-scope");
    const adapter = new GmailEmailAdapter(replay.googleGmail(), config);
    await expect(adapter.send({ ...message, idempotencyKey: "k" })).rejects.toThrow(/insufficient authentication scopes/);
    expect(replay.calls).toHaveLength(1);
    replay.use("messages.send", null);
    await expect(adapter.send({ ...message, idempotencyKey: "k" })).resolves.toEqual({ messageRef: "MESSAGE_ID" });
    expect(replay.calls).toHaveLength(2);
  });

  it("never sends when a header value carries a line break", async () => {
    const replay = openReplay();
    const adapter = new GmailEmailAdapter(replay.googleGmail(), config);
    await expect(
      adapter.send({ ...message, subject: "hi\r\nBcc: victim@example.com", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(EmailHeaderInjectionError);
    await expect(
      adapter.send({ ...message, to: "a@example.com\nBcc: victim@example.com", idempotencyKey: "k2" }),
    ).rejects.toBeInstanceOf(EmailHeaderInjectionError);
    expect(replay.calls).toHaveLength(0);
  });

  it("refuses a misconfigured sender at construction, not at the first sign-in", () => {
    const replay = openReplay();
    expect(() => new GmailEmailAdapter(replay.googleGmail(), { senderAddress: "x\r\nBcc: a@b.co" })).toThrow();
    expect(() => new GmailEmailAdapter(replay.googleGmail(), { senderAddress: "not-an-address" })).toThrow();
  });
});

describe("guardEmailSender (the allowlist)", () => {
  it("throws before the transport for a recipient not on the list, and passes one that is", async () => {
    const replay = openReplay();
    const refused: string[] = [];
    const guard = new SandboxGuard({
      allowlist: ["Priya@Example.com"],
      onRefused: (d) => refused.push(...d.refused),
    });
    const guarded = guardEmailSender(new GmailEmailAdapter(replay.googleGmail(), config), guard);

    await expect(guarded.send({ ...message, to: "stranger@example.net", idempotencyKey: "a" })).rejects.toBeInstanceOf(
      SandboxRefusal,
    );
    expect(replay.calls).toHaveLength(0);
    expect(refused).toEqual(["stranger@example.net"]);

    await expect(guarded.send({ ...message, idempotencyKey: "b" })).resolves.toBeDefined();
    expect(replay.calls).toHaveLength(1);
  });
});

describe("recordingGoogleGmailTransport", () => {
  it("never writes the raw message — recipient and link — into a fixture", async () => {
    const sink = memoryFixtureSink();
    const inner = async () => ({ id: "18c3f5a7b2d1e4f0", threadId: "18c3f5a7b2d1e4f0", labelIds: ["SENT"] });
    const adapter = new GmailEmailAdapter(
      recordingGoogleGmailTransport(inner, { sink, now: () => new Date("2026-09-29T00:00:00Z") }),
      config,
    );
    await adapter.send({ ...message, idempotencyKey: "k" });

    expect(sink.fixtures).toHaveLength(1);
    const text = JSON.stringify(sink.fixtures[0]);
    expect(sink.fixtures[0]).toMatchObject({
      vendor: "google-gmail",
      call: "messages.send",
      source: "live",
      request: { body: { raw: GMAIL_RAW_PLACEHOLDER } },
    });
    expect(text).not.toContain("priya");
    expect(text).not.toContain("token=abc");
  });
});

describe("FakeEmail", () => {
  it("records a send and dedupes on the idempotency key", async () => {
    const recorder = new Recorder();
    const fake = new FakeEmail(recorder);
    const first = await fake.send({ ...message, idempotencyKey: "k" });
    const second = await fake.send({ ...message, idempotencyKey: "k" });
    expect(second).toEqual(first);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.detail).toMatchObject({ to: "priya@example.com", subject: "Your sign-in link" });

    await fake.send({ ...message, idempotencyKey: "other" });
    expect(fake.sent).toHaveLength(2);
  });
});
