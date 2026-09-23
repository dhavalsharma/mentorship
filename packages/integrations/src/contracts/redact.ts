/**
 * What must never reach a checked-in fixture: credentials, and the people a
 * live run touched. Applied to every request and response a
 * `recordingTransport` writes, before it is written.
 *
 * Deliberately over-eager. A fixture only has to preserve *shape* — the replay
 * matches on the route and the adapter reads fields by name — so replacing a
 * value that turned out to be harmless costs nothing, and leaving a token in
 * a committed file costs a rotation and an incident.
 */

/** Keys whose value is a credential regardless of what it looks like. */
const SECRET_KEY =
  /^(authorization|password|secret|client_secret|api_?key|access_token|refresh_token|id_token|bot_token|token|signing_secret)$/i;

/** Credential-shaped strings, wherever they appear (including error messages). */
const SECRET_VALUES: RegExp[] = [
  /xox[abposre]-[A-Za-z0-9-]+/g, // Slack bot/user/app tokens
  /ya29\.[A-Za-z0-9._-]+/g, // Google OAuth access tokens
  /1\/\/[A-Za-z0-9._-]{20,}/g, // Google refresh tokens
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Slack workspace-scoped ids for people and workspaces (`U…`, `W…`, `T…`,
 * `B…`, `E…`). Channel ids are left alone: they name a conversation the test
 * created, not a person, and the replay never needs them to be real.
 */
const SLACK_PERSON_ID = /^[UWTBE][A-Z0-9]{8,}$/;

export const REDACTED = "[REDACTED]";

export function redact<T>(value: T): T {
  const emails = new Map<string, string>();
  const ids = new Map<string, string>();

  const email = (address: string): string => {
    const key = address.toLowerCase();
    let replacement = emails.get(key);
    if (!replacement) {
      // Numbered so two distinct attendees stay distinct, and the `+tag` is
      // kept as a flag (not its content), because Drive refusing a
      // plus-addressed share is a real, recorded vendor behaviour
      // (docs/live-tenant-testing.md) and must stay visible in a fixture.
      const plus = address.split("@")[0]!.includes("+") ? "+tag" : "";
      replacement = `user${emails.size + 1}${plus}@example.com`;
      emails.set(key, replacement);
    }
    return replacement;
  };

  const slackId = (id: string): string => {
    let replacement = ids.get(id);
    if (!replacement) {
      replacement = `${id[0]}REDACTED${String(ids.size + 1).padStart(2, "0")}`;
      ids.set(id, replacement);
    }
    return replacement;
  };

  const scrubString = (s: string): string => {
    if (SLACK_PERSON_ID.test(s)) return slackId(s);
    let out = s;
    for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
    return out.replace(EMAIL, email);
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        // `users` on `conversations.open` is a comma-joined id list.
        if (k === "users" && typeof inner === "string") {
          out[k] = inner
            .split(",")
            .map((part) => scrubString(part.trim()))
            .join(",");
          continue;
        }
        out[k] = SECRET_KEY.test(k) && inner !== undefined ? REDACTED : walk(inner);
      }
      return out;
    }
    return v;
  };

  return walk(value) as T;
}
