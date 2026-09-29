/**
 * RFC 5322 / MIME message building for outbound email — vendor-neutral, so a
 * future SMTP or transactional-provider sender reuses it, and pure, so every
 * rule below is a unit test rather than something learned from a bounce.
 *
 * The one rule that matters more than the rest: **no header value may carry a
 * CR or LF.** Recipients, subjects and display names all end up derived from
 * data people typed (an invite's email address and display name, a cohort
 * name). A newline in any of them would let that data add a header — `Bcc:`,
 * most obviously — to a message we sign with our own sender address. So every
 * header input is checked and refused (`EmailHeaderInjectionError`), rather
 * than encoded around: a subject containing a newline is never legitimate, and
 * an error that names the field is easier to notice than a message that
 * quietly went out with the newline stripped.
 */

export class EmailHeaderInjectionError extends Error {
  constructor(readonly field: string) {
    super(`email ${field} contains a line break or NUL — refusing to build the message`);
    this.name = "EmailHeaderInjectionError";
  }
}

export class InvalidEmailAddressError extends Error {
  constructor(readonly field: string) {
    super(`email ${field} is not a plain ASCII addr-spec`);
    this.name = "InvalidEmailAddressError";
  }
}

const UNSAFE_HEADER = /[\r\n\0]/;

export function assertHeaderSafe(field: string, value: string): void {
  if (UNSAFE_HEADER.test(value)) throw new EmailHeaderInjectionError(field);
}

/**
 * A deliberately conservative addr-spec: RFC 5321's atext local part, dotted
 * ASCII domain. It refuses quoted local parts, comments, display-name forms
 * (`Name <a@b>`), lists (`a@b, c@d`) and non-ASCII (EAI/IDN) addresses — every
 * one of which is a way to smuggle a second recipient or an odd parse past a
 * check that only looked at "contains an @". A real address this refuses
 * fails loudly at send time and is logged, which is the right trade for a
 * sender that mails sign-in links.
 */
const ADDR_SPEC =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function assertAddress(field: string, value: string): void {
  assertHeaderSafe(field, value);
  if (value.length > 254 || !ADDR_SPEC.test(value)) throw new InvalidEmailAddressError(field);
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * RFC 2047 "B" encoded-words, each within the 75-character limit and split on
 * code-point boundaries so a multi-byte character is never cut in half.
 * 45 bytes -> 60 base64 characters + 12 of framing = 72.
 */
export function encodeWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  const flush = () => {
    if (chunk.length > 0) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
    }
  };
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) flush();
    chunk += char;
  }
  flush();
  return words.join("\r\n ");
}

/** Subject: plain when short printable ASCII, encoded words otherwise. */
export function encodeSubject(subject: string): string {
  assertHeaderSafe("subject", subject);
  return PRINTABLE_ASCII.test(subject) && subject.length <= 60 ? subject : encodeWords(subject);
}

/** A display name as a quoted-string, or encoded words when it is not plain ASCII. */
export function encodeDisplayName(name: string): string {
  assertHeaderSafe("display name", name);
  if (PRINTABLE_ASCII.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return encodeWords(name);
}

function base64Lines(content: string): string {
  const crlf = content.replace(/\r\n|\r|\n/g, "\r\n");
  const b64 = Buffer.from(crlf, "utf8").toString("base64");
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface MimeInput {
  from: { address: string; name?: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  date: Date;
  /** Without the angle brackets. */
  messageId: string;
}

/**
 * The message as RFC 5322 text with CRLF line endings. Bodies are always
 * base64 UTF-8: it is 8-bit safe on every hop, needs no quoted-printable
 * line-length bookkeeping, and — usefully — cannot contain the multipart
 * boundary, whose `=_` opener never occurs inside a base64 body.
 */
export function buildMimeMessage(input: MimeInput): string {
  assertAddress("from address", input.from.address);
  assertAddress("to", input.to);
  if (input.replyTo !== undefined) assertAddress("reply-to", input.replyTo);
  assertHeaderSafe("message-id", input.messageId);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/.test(input.messageId)) {
    throw new EmailHeaderInjectionError("message-id");
  }
  const fromValue =
    input.from.name !== undefined && input.from.name.length > 0
      ? `${encodeDisplayName(input.from.name)} <${input.from.address}>`
      : input.from.address;

  const headers: string[] = [
    `From: ${fromValue}`,
    `To: ${input.to}`,
    ...(input.replyTo !== undefined ? [`Reply-To: ${input.replyTo}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
  ];

  if (input.html === undefined) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(input.text),
      "",
    ].join("\r\n");
  }

  const boundary = `=_mentorship_${Buffer.from(input.messageId, "utf8")
    .toString("hex")
    .slice(0, 24)}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** base64url without padding — the encoding Gmail's `raw` field wants. */
export function toBase64Url(message: string): string {
  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
