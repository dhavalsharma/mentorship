import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  EmailHeaderInjectionError,
  encodeSubject,
  InvalidEmailAddressError,
  toBase64Url,
  type MimeInput,
} from "@mentorship/integrations";

const base: MimeInput = {
  from: { address: "noreply@example.org", name: "Mentorship" },
  to: "priya@example.com",
  subject: "Your sign-in link",
  text: "Hello\nworld",
  html: "<p>Hello</p>",
  date: new Date("2026-09-29T10:00:00Z"),
  messageId: "abc123@example.org",
};

function partsOf(message: string): { headers: Map<string, string>; body: string } {
  const [head, ...rest] = message.split("\r\n\r\n");
  const headers = new Map<string, string>();
  // Unfold continuation lines first.
  for (const line of head!.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    headers.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return { headers, body: rest.join("\r\n\r\n") };
}

describe("buildMimeMessage", () => {
  it("builds a CRLF multipart/alternative message with the required headers", () => {
    const message = buildMimeMessage(base);
    expect(message).not.toMatch(/[^\r]\n/); // every line ending is CRLF
    const { headers, body } = partsOf(message);
    expect(headers.get("From")).toBe('"Mentorship" <noreply@example.org>');
    expect(headers.get("To")).toBe("priya@example.com");
    expect(headers.get("Subject")).toBe("Your sign-in link");
    expect(headers.get("Date")).toBe("Tue, 29 Sep 2026 10:00:00 GMT");
    expect(headers.get("Message-ID")).toBe("<abc123@example.org>");
    expect(headers.get("MIME-Version")).toBe("1.0");
    const boundary = /boundary="([^"]+)"/.exec(headers.get("Content-Type")!)![1]!;
    expect(headers.get("Content-Type")).toMatch(/^multipart\/alternative;/);
    const sections = body.split(`--${boundary}`).filter((s) => s.trim() && s.trim() !== "--");
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatch(/text\/plain; charset="UTF-8"/);
    expect(sections[1]).toMatch(/text\/html; charset="UTF-8"/);
    const decode = (section: string) =>
      Buffer.from(section.split("\r\n\r\n")[1]!.replace(/\s+/g, ""), "base64").toString("utf8");
    // Bodies are normalised to CRLF, the canonical text form.
    expect(decode(sections[0]!)).toBe("Hello\r\nworld");
    expect(decode(sections[1]!)).toBe("<p>Hello</p>");
    expect(body.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it("is a single text/plain part when there is no html", () => {
    const { html: _html, ...textOnly } = base;
    const { headers } = partsOf(buildMimeMessage(textOnly));
    expect(headers.get("Content-Type")).toBe('text/plain; charset="UTF-8"');
    expect(headers.get("Content-Transfer-Encoding")).toBe("base64");
  });

  it("wraps base64 bodies at 76 columns", () => {
    const message = buildMimeMessage({ ...base, text: "é".repeat(400) });
    for (const line of message.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const b64Lines = message.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
    expect(b64Lines.length).toBeGreaterThan(1);
    for (const l of b64Lines) expect(l.length).toBeLessThanOrEqual(76);
  });

  it("encodes a non-ASCII subject as RFC 2047 words within 75 characters each", () => {
    const subject = "Invitation à rejoindre « Programme de mentorat » — 日本語のテスト";
    const encoded = encodeSubject(subject);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const decoded = words
      .map((w) => Buffer.from(w.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(subject);
    // And it survives the whole message unfolded.
    expect(partsOf(buildMimeMessage({ ...base, subject })).headers.get("Subject")).toContain("=?UTF-8?B?");
  });

  it("encodes a non-ASCII display name and escapes quotes in an ASCII one", () => {
    expect(
      partsOf(buildMimeMessage({ ...base, from: { address: "a@example.org", name: "Café Mentor" } }))
        .headers.get("From"),
    ).toMatch(/^=\?UTF-8\?B\?.+\?= <a@example\.org>$/);
    expect(
      partsOf(buildMimeMessage({ ...base, from: { address: "a@example.org", name: 'The "Team"' } }))
        .headers.get("From"),
    ).toBe('"The \\"Team\\"" <a@example.org>');
  });

  it("includes Reply-To only when given", () => {
    expect(partsOf(buildMimeMessage(base)).headers.has("Reply-To")).toBe(false);
    expect(
      partsOf(buildMimeMessage({ ...base, replyTo: "help@example.org" })).headers.get("Reply-To"),
    ).toBe("help@example.org");
  });

  it("base64url has no padding and no + or /", () => {
    const raw = toBase64Url(buildMimeMessage(base));
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(buildMimeMessage(base));
  });
});

describe("header injection", () => {
  const injections = ["\r\nBcc: victim@example.com", "\nBcc: victim@example.com", "x\rBcc: y", "a\0b"];

  it.each(injections)("rejects a line break in the subject: %j", (evil) => {
    expect(() => buildMimeMessage({ ...base, subject: `hello${evil}` })).toThrow(
      EmailHeaderInjectionError,
    );
  });

  it.each(injections)("rejects a line break in the recipient: %j", (evil) => {
    expect(() => buildMimeMessage({ ...base, to: `priya@example.com${evil}` })).toThrow(
      EmailHeaderInjectionError,
    );
  });

  it.each(injections)("rejects a line break in the display name, reply-to and message id: %j", (evil) => {
    expect(() =>
      buildMimeMessage({ ...base, from: { address: "a@example.org", name: `Team${evil}` } }),
    ).toThrow(EmailHeaderInjectionError);
    expect(() => buildMimeMessage({ ...base, replyTo: `a@example.org${evil}` })).toThrow(
      EmailHeaderInjectionError,
    );
    expect(() => buildMimeMessage({ ...base, messageId: `id${evil}@example.org` })).toThrow(
      EmailHeaderInjectionError,
    );
  });

  it("does not treat a newline in the *body* as a header — it stays inside base64", () => {
    const message = buildMimeMessage({ ...base, text: "hi\r\nBcc: victim@example.com" });
    expect(message).not.toMatch(/^Bcc:/m);
  });

  it.each([
    "Priya <priya@example.com>",
    "a@example.com, b@example.com",
    "a@example.com b@example.com",
    '"a b"@example.com',
    "no-at-sign",
    "prïya@example.com",
    "",
  ])("rejects a recipient that is not one plain addr-spec: %j", (to) => {
    expect(() => buildMimeMessage({ ...base, to })).toThrow(InvalidEmailAddressError);
  });

  it("accepts a plus-addressed recipient", () => {
    expect(() => buildMimeMessage({ ...base, to: "sam+mentor@example.com" })).not.toThrow();
  });
});
