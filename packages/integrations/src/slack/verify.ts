import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack's interaction endpoint has a hard ~3 second acknowledgement deadline,
 * and no request may be trusted before its signature checks out — an
 * unverified interaction endpoint lets anyone book meetings for anyone.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export interface SlackSignatureInput {
  signingSecret: string;
  /** Raw `x-slack-request-timestamp` header value. */
  timestamp: string;
  /** The exact, unparsed request body — signing covers the raw bytes. */
  rawBody: string;
  /** Raw `x-slack-signature` header value, e.g. `v0=...`. */
  signature: string;
}

export function verifySlackSignature(
  input: SlackSignatureInput,
  now: Date = new Date(),
): boolean {
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  // A replay defence, not a network-latency budget — five minutes is generous
  // on purpose.
  if (Math.abs(now.getTime() / 1000 - ts) > MAX_CLOCK_SKEW_SECONDS) return false;

  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const expected =
    "v0=" + createHmac("sha256", input.signingSecret).update(base).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
