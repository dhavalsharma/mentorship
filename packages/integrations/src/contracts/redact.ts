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

export const REDACTED = "[REDACTED]";

/** Keys whose value is a credential regardless of what it looks like. */
const SECRET_KEY =
  /^(authorization|password|secret|client_secret|api_?key|access_token|refresh_token|id_token|bot_token|token|signing_secret)$/i;

/** Credential-shaped strings, wherever they appear (including error messages). */
const SECRET_VALUES: RegExp[] = [
  /xox[abposre]-[A-Za-z0-9-]+/g, // Slack bot/user/app tokens
  /xapp-[A-Za-z0-9-]+/g, // Slack app-level (socket mode) tokens
  /ya29\.[A-Za-z0-9._-]+/g, // Google OAuth access tokens
  /1\/\/[A-Za-z0-9._-]{20,}/g, // Google refresh tokens
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/**
 * Credentials that are only recognisable by where they sit in a URL: an
 * opaque `?access_token=…`, and the secret path of a Slack incoming webhook
 * (whose `T…`/`B…` segments would otherwise be the only part redacted).
 * The parameter name and the host are kept, so a fixture still says what
 * kind of URL it was.
 */
const SECRET_IN_URL: [RegExp, string][] = [
  [/([?&](?:access_token|refresh_token|id_token|token|key|api_key|client_secret|signature|sig)=)[^&#\s"'<>|]+/gi, `$1${REDACTED}`],
  [/(hooks\.slack\.com\/services\/)[^\s"'<>|]+/g, `$1${REDACTED}`],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** What `email()` produces — left as-is, so re-redacting a fixture is a no-op. */
const EMAIL_PLACEHOLDER = /^user\d+(\+tag)?@example\.com$/i;

/**
 * Slack workspace-scoped ids for people and workspaces (`U…`, `W…`, `T…`,
 * `B…`, `E…`). Channel ids are left alone: they name a conversation the test
 * created, not a person, and the replay never needs them to be real.
 */
const SLACK_PERSON_ID = /^(?![UWTBE]REDACTED\d)[UWTBE][A-Z0-9]{8,}$/;

/**
 * The same ids embedded in text: `<@U…>` mentions in a message's `text` or
 * `blocks` (which `chat.postMessage` echoes back), ids in a URL path, ids in
 * an error string. Two narrowings over the whole-string rule, because prose is
 * full of uppercase words: the id must stand alone between word boundaries
 * (so `PREVIEW_SUGGESTIONS_INLINE` and the `T10` of a timestamp are safe) and
 * must contain a digit (so `WEDNESDAYS` and `TRANSCRIPTION` are too — every
 * real Slack id does). Our own placeholders are excluded so a re-redacted
 * fixture comes out unchanged.
 */
const SLACK_PERSON_ID_IN_TEXT = /\b(?![UWTBE]REDACTED\d)[UWTBE](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g;

/**
 * A labelled mention, `<@U…|display.name>`: the label is the person's name,
 * so it goes too. The `|` is kept so the fixture still shows a labelled
 * mention was sent. Channel mentions (`<#C…|name>`) are left alone for the
 * reason above.
 */
const SLACK_LABELLED_MENTION = /<@([UWB][A-Z0-9]{8,})\|[^>]*>/g;


export function redact<T>(value: T): T {
  const emails = new Map<string, string>();
  const ids = new Map<string, string>();

  const email = (address: string): string => {
    if (EMAIL_PLACEHOLDER.test(address)) return address;
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
    // Secrets first: a webhook path or a token may contain id-shaped runs,
    // and they should vanish whole rather than be half-mapped to placeholders.
    for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
    for (const [pattern, replacement] of SECRET_IN_URL) out = out.replace(pattern, replacement);
    out = out.replace(SLACK_LABELLED_MENTION, (_m, id: string) => `<@${slackId(id)}|${REDACTED}>`);
    out = out.replace(SLACK_PERSON_ID_IN_TEXT, slackId);
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
