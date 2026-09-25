import { createHash } from "node:crypto";
import { z } from "zod";
import type { AdapterCapabilities, DocumentAdapter } from "@mentorship/core";
import { AdapterCapabilitiesSchema, resolveManagedRegionWrite } from "@mentorship/core";
// The markers are imported from `fakes.ts` rather than redeclared here: two
// copies of a delimiter is how a real adapter and the reference implementation
// quietly stop agreeing, and a doc written by one would then be unreadable by
// the other. They belong to the projection contract, not to the fake.
import { MANAGED_END, MANAGED_START } from "../fakes.js";
import { staticAccessToken, type GoogleAccessTokenSource } from "./auth.js";

/**
 * Google Drive + Docs adapter for the `document` slot — the running shared doc
 * per pair (ADR-0005: the database is the source of truth, this file is a
 * projection of it).
 *
 * STATUS: the API shapes are real; this has **not** been run against a live
 * Drive or Docs account. Supply an access token minted for
 * `https://www.googleapis.com/auth/documents` and
 * `https://www.googleapis.com/auth/drive.file` — strictly more than the
 * Calendar adapter needs, so an existing calendar token will not work here
 * (see docs/live-tenant-testing.md).
 */

/**
 * Vendor config for this adapter, stored per org on
 * `integration_bindings.config`. It lives here rather than in
 * `packages/core` because core must never learn what a Drive folder is
 * (invariant 1) — the slot port is the only vendor-agnostic contract.
 */
export const GoogleDriveDocumentConfigSchema = z.object({
  folderId: z.string().min(1),
  /** A template doc copied for each new pair. Omitted means start blank. */
  guidelineDocId: z.string().min(1).optional(),
});
export type GoogleDriveDocumentConfig = z.infer<
  typeof GoogleDriveDocumentConfigSchema
>;

/**
 * Deliberately permissive — this is not validation, it is the difference
 * between an address Drive can act on and one that would make the whole
 * permissions call fail. Anything stricter starts rejecting real addresses.
 */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export type GoogleDocsApi = "drive" | "docs";

export type GoogleDocsTransport = (
  api: GoogleDocsApi,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
) => Promise<Record<string, unknown>>;

const API_BASE: Record<GoogleDocsApi, string> = {
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
};

/**
 * Two APIs behind one transport rather than two transports: every call here
 * carries the same bearer token, and a caller that had to hold two functions
 * could bind them to different credentials without noticing.
 */
/** A bare string or a `GoogleAccessTokenSource` — see `./auth.ts`. */
export function httpGoogleDocsTransport(
  accessToken: string | GoogleAccessTokenSource,
): GoogleDocsTransport {
  const getToken = typeof accessToken === "string" ? staticAccessToken(accessToken) : accessToken;
  return async (api, path, init) => {
    const url = new URL(`${API_BASE[api]}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${await getToken()}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`google ${api} ${path} failed: ${JSON.stringify(json)}`);
    }
    return json;
  };
}

export class GoogleDriveDocumentAdapter implements DocumentAdapter {
  readonly slot = "document" as const;
  readonly id = "google-drive";

  // ADR-0005's two safeguards. Per-instance and in-memory, like every other
  // fake/adapter bookkeeping in this repo (`FakeCalendar`'s dedupe map is the
  // same shape of gap) — a worker restart forgets the baseline and the very
  // next render treats the region as untouched, which is safe (it just skips
  // one opportunity to detect an edit) rather than unsafe. Moving this into
  // durable storage is a `db`-layer concern (invariant 2: adapters never
  // import `db`), and belongs to whichever caller wires this adapter up.
  private readonly lastRendered = new Map<string, string>();

  constructor(
    private readonly call: GoogleDocsTransport,
    private readonly config: GoogleDriveDocumentConfig,
    private readonly onWarn?: (
      message: string,
      detail?: Record<string, unknown>,
    ) => void,
  ) {}

  async probe(): Promise<AdapterCapabilities> {
    // The folder is the one thing a misconfiguration is most likely to get
    // wrong and the one thing every later call depends on, so the probe reads
    // it rather than something cheaper like `about.get`.
    await this.call("drive", `/files/${this.config.folderId}`, {
      method: "GET",
      query: { fields: "id,mimeType", supportsAllDrives: "true" },
    });
    return AdapterCapabilitiesSchema.parse({ anchoredDocEdits: true });
  }

  async renderManagedRegion(input: {
    docRef: string | null;
    title: string;
    markdown: string;
    collaborators: { email: string }[];
    idempotencyKey: string;
  }): Promise<{ docRef: string; url: string; revisionId: string; pinned: boolean }> {
    const documentId =
      input.docRef ?? (await this.createDoc(input.title, input.idempotencyKey));
    // Before the write, not after: a render that fails half way should still
    // have left the pair able to open the doc. Neither the folder's own
    // sharing nor `files.copy` grants them anything — Drive does not carry a
    // source document's permissions onto the copy — so without this step the
    // link the saga posts can go nowhere.
    await this.grantEditAccess(documentId, input.collaborators);
    const { revisionId, pinned } = await this.writeManagedRegion(documentId, input.markdown);
    return { docRef: documentId, url: documentUrl(documentId), revisionId, pinned };
  }

  // -------------------------------------------------------------------------

  /**
   * This effect fires once per extraction, not once per pair, so the existing
   * permissions are read first and only the genuinely missing grants are sent.
   * That is not just tidiness about duplicate permission objects: a repeat
   * `permissions.create` re-sends Drive's "you now have access" email, and a
   * pair that gets one of those after every session stops reading them.
   */
  private async grantEditAccess(
    documentId: string,
    collaborators: { email: string }[],
  ): Promise<void> {
    const wanted: string[] = [];
    for (const { email } of collaborators) {
      const trimmed = email.trim();
      if (EMAIL.test(trimmed)) {
        wanted.push(trimmed);
        continue;
      }
      // One unusable address must not cost the pair their session notes: the
      // doc still renders, and the gap is reported rather than swallowed.
      this.onWarn?.("document not shared: unusable email", { documentId, email });
    }
    if (wanted.length === 0) return;

    const listed = await this.call("drive", `/files/${documentId}/permissions`, {
      method: "GET",
      query: {
        fields: "permissions(id,emailAddress,role)",
        supportsAllDrives: "true",
      },
    });
    const permissions =
      (listed["permissions"] as
        | { emailAddress?: string; role?: string }[]
        | undefined) ?? [];
    const already = new Set(
      permissions
        .filter((p) => p.role === "writer" || p.role === "owner")
        .map((p) => (p.emailAddress ?? "").toLowerCase()),
    );

    for (const email of wanted) {
      if (already.has(email.toLowerCase())) continue;
      await this.call("drive", `/files/${documentId}/permissions`, {
        method: "POST",
        query: {
          // The one time this person is told the doc exists. Suppressing it
          // would leave the Slack link as the only notice they ever get.
          sendNotificationEmail: "true",
          supportsAllDrives: "true",
          fields: "id",
        },
        body: { role: "writer", type: "user", emailAddress: email },
      });
      already.add(email.toLowerCase());
    }
  }

  /**
   * Invariant 6 on the one call here that is not naturally idempotent.
   *
   * A pair's first render has no doc id. If the worker dies after Drive has
   * created the file but before `document.rendered` commits (the id reaches
   * the saga only as that event — invariant 5), the retry arrives with the
   * same idempotency key and still no id. Without a key-based lookup it made
   * a second doc and re-sent both access emails (journey-suite bug #8).
   *
   * Drive takes no client idempotency key, so the key is written onto the
   * file itself, *in the same call that creates it*, as a private
   * `appProperties` entry, and looked up in the folder before any create.
   * Both writes being one atomic call is the point: there is no instant at
   * which the doc exists without its key, so there is no crash window left
   * in which a retry cannot find it.
   *
   * Rejected alternatives:
   *   - **Adopt a file of the same name in the folder** (what this did
   *     before). It covers the retry, but a name is not an identity: two
   *     pairs whose naming template renders the same title would share one
   *     doc — and the second pair would be *granted edit access to the first
   *     pair's notes*. A doc a participant renamed was also never found.
   *   - **Persist the created id durably before writing** (emit a
   *     "document.created" event between create and render). That moves the
   *     window, it does not close it: the crash between Drive creating the
   *     file and our event committing is exactly bug #8.
   *   - **`files.generateIds` + `files.create` with that id**, the Drive
   *     analogue of the Calendar adapter's key-as-event-id. The id has to be
   *     minted by Google, so it would need its own effect and its own saga
   *     state to carry it back (invariant 5) before the create — a new state
   *     in `session-lifecycle` for one vendor's quirk — and `files.copy`
   *     does not document accepting one.
   *   - **`documents.create` then move into the folder** (the old blank
   *     path). Three calls, and a crash after the first leaves a keyless doc
   *     in the service account's My Drive root that nothing will ever find.
   *     `files.create` with the Docs mime type makes the same empty Doc,
   *     already in the folder, already keyed.
   *
   * Scope: `drive.file` covers all of it — the adapter only ever lists,
   * reads and tags files it created itself, and `appProperties` are private
   * to the creating OAuth client. That is from Drive's documentation and
   * reasoning, **not verified live**; nor is how soon a just-created file
   * becomes visible to `files.list` (Drive search is not documented as
   * read-your-writes — a retry within the index lag would still create a
   * second file). `orderBy: createdTime` means that, should two ever exist,
   * every retry settles on the same, oldest one.
   */
  private async createDoc(title: string, idempotencyKey: string): Promise<string> {
    const tag = idempotencyTag(idempotencyKey);
    const existing = await this.findByKey(tag);
    if (existing !== null) return existing;

    const appProperties = { [IDEMPOTENCY_PROPERTY]: tag };

    if (this.config.guidelineDocId !== undefined) {
      const copied = await this.call(
        "drive",
        `/files/${this.config.guidelineDocId}/copy`,
        {
          method: "POST",
          query: { supportsAllDrives: "true", fields: "id" },
          body: { name: title, parents: [this.config.folderId], appProperties },
        },
      );
      return String(copied["id"]);
    }

    const created = await this.call("drive", "/files", {
      method: "POST",
      query: { supportsAllDrives: "true", fields: "id" },
      body: {
        name: title,
        mimeType: GOOGLE_DOC_MIME_TYPE,
        parents: [this.config.folderId],
        appProperties,
      },
    });
    return String(created["id"]);
  }

  private async findByKey(tag: string): Promise<string | null> {
    const res = await this.call("drive", "/files", {
      method: "GET",
      query: {
        q:
          `'${this.config.folderId}' in parents and appProperties has { key='${IDEMPOTENCY_PROPERTY}' and ` +
          `value='${driveQueryEscape(tag)}' } and trashed = false`,
        fields: "files(id)",
        orderBy: "createdTime",
        pageSize: "1",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      },
    });
    const files = (res["files"] as { id?: string }[] | undefined) ?? [];
    return files[0]?.id ?? null;
  }

  private async writeManagedRegion(
    documentId: string,
    markdown: string,
  ): Promise<{ revisionId: string; pinned: boolean }> {
    const doc = await this.call("docs", `/documents/${documentId}`, {
      method: "GET",
    });
    const runs = collectTextRuns(doc);
    const region = findManagedRegion(runs);
    const baseline = this.lastRendered.get(documentId) ?? null;

    // Only worth asking "was this us?" when there is both an existing region
    // and a baseline to compare it against — a brand new document, or one
    // we've never rendered into this process, has nothing to protect yet
    // (`resolveManagedRegionWrite` treats a null baseline as "always render"),
    // so skip the extra Drive round trip.
    const isEcho =
      region !== null && baseline !== null
        ? await this.isEchoRevision(documentId)
        : false;

    const { text, pinned } = resolveManagedRegionWrite({
      markdown,
      currentRegionText: region?.text ?? null,
      lastRendered: baseline,
      isEcho,
    });

    if (pinned) {
      // A human edited the managed region since our last render, and it was
      // not our own echo — their edit wins (ADR-0005). Skip the write
      // entirely rather than overwrite it; the baseline is left untouched, so
      // the same divergence is detected again next time and the block stays
      // pinned until the doc's content matches our baseline again.
      return { revisionId: String(doc["revisionId"] ?? ""), pinned: true };
    }

    const requests =
      region === null
        ? [
            {
              insertText: {
                location: { index: endOfBody(runs) },
                text: `\n${MANAGED_START}\n${text}\n${MANAGED_END}\n`,
              },
            },
          ]
        : [
            // Delete before insert, and only between the markers. Everything
            // the pair wrote outside them — including the guideline doc's own
            // content — is never in this range (ADR-0005).
            ...(region.end > region.start
              ? [
                  {
                    deleteContentRange: {
                      range: { startIndex: region.start, endIndex: region.end },
                    },
                  },
                ]
              : []),
            {
              insertText: {
                location: { index: region.start },
                text: `\n${text}\n`,
              },
            },
          ];

    const res = await this.call(
      "docs",
      `/documents/${documentId}:batchUpdate`,
      { method: "POST", body: { requests } },
    );
    const writeControl = res["writeControl"] as
      | { requiredRevisionId?: string }
      | undefined;
    const revisionId = writeControl?.requiredRevisionId ?? String(doc["revisionId"] ?? "");
    this.lastRendered.set(documentId, text);
    return { revisionId, pinned: false };
  }

  /**
   * Echo suppression (ADR-0005): true when the document's current revision
   * was authored by us rather than a human. Drive's `User` resource carries
   * `me: true` for the authenticated caller on the revision that made the
   * change, which is the vendor-specific fact the core comparison logic in
   * `resolveManagedRegionWrite` cannot know on its own.
   */
  private async isEchoRevision(documentId: string): Promise<boolean> {
    // Drive returns revisions oldest-first with no reverse-order option, so
    // the true latest revision is the last entry of the *last* page, not the
    // last entry of the first page — a doc with more than one page of
    // history (1000 revisions, plausible over a long-lived pairing) would
    // otherwise have this answer a stale question. Walking every page only
    // to keep the final entry is the API's own cost, not an avoidable one:
    // each page's `lastModifyingUser` payload is discarded once the next
    // page arrives, so memory stays bounded to one page at a time.
    let last: { lastModifyingUser?: { me?: boolean } } | undefined;
    let pageToken: string | undefined;
    do {
      const res = await this.call("drive", `/files/${documentId}/revisions`, {
        method: "GET",
        query: {
          fields: "nextPageToken, revisions(lastModifyingUser(me))",
          pageSize: "1000",
          ...(pageToken ? { pageToken } : {}),
        },
      });
      const revisions =
        (res["revisions"] as { lastModifyingUser?: { me?: boolean } }[] | undefined) ?? [];
      if (revisions.length > 0) {
        last = revisions[revisions.length - 1];
      }
      pageToken = typeof res["nextPageToken"] === "string" ? res["nextPageToken"] : undefined;
    } while (pageToken);
    return last?.lastModifyingUser?.me === true;
  }
}

/** The private `appProperties` entry a created doc carries its render's key in. */
export const IDEMPOTENCY_PROPERTY = "mentorshipIdempotencyKey";

const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

/**
 * Drive caps one app property at 124 bytes, key and value together. The
 * engine's keys (`{instance id}:{step}:{index}`) fit with room to spare; a
 * longer key is hashed rather than truncated, since two truncated keys can
 * collide and a hash (for this purpose) cannot.
 */
export function idempotencyTag(idempotencyKey: string): string {
  const limit = 124 - Buffer.byteLength(IDEMPOTENCY_PROPERTY);
  if (Buffer.byteLength(idempotencyKey) <= limit) return idempotencyKey;
  return `sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function driveQueryEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/**
 * Admins copy a URL out of the browser bar; asking them to hand-extract the
 * id is an invitation to paste a truncated one. Both accept a bare id
 * unchanged, so the same function serves the env-var path too.
 */
export function extractDriveFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /\/folders\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (match) return match[1]!;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

export function extractGoogleDocId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /\/document\/d\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (match) return match[1]!;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Docs indices count structural elements, not characters, so a marker's
 * position in the flattened text cannot be used as a document index directly.
 * Each run records where it starts in both coordinate systems, which is what
 * makes the mapping back exact.
 */
interface TextRun {
  text: string;
  /** Offset in the flattened document text. */
  flatStart: number;
  /** Index in the document's own coordinate system. */
  docStart: number;
  docEnd: number;
}

export function collectTextRuns(doc: Record<string, unknown>): TextRun[] {
  const body = doc["body"] as { content?: unknown[] } | undefined;
  const runs: TextRun[] = [];
  let flat = 0;

  const visit = (elements: unknown[] | undefined): void => {
    for (const element of elements ?? []) {
      const el = element as Record<string, unknown>;
      const paragraph = el["paragraph"] as { elements?: unknown[] } | undefined;
      if (paragraph) {
        for (const pe of paragraph.elements ?? []) {
          const child = pe as Record<string, unknown>;
          const textRun = child["textRun"] as { content?: string } | undefined;
          if (!textRun?.content) continue;
          const docStart = Number(child["startIndex"] ?? 0);
          runs.push({
            text: textRun.content,
            flatStart: flat,
            docStart,
            docEnd: Number(child["endIndex"] ?? docStart + textRun.content.length),
          });
          flat += textRun.content.length;
        }
      }
      const table = el["table"] as { tableRows?: unknown[] } | undefined;
      for (const row of table?.tableRows ?? []) {
        const cells = (row as { tableCells?: unknown[] }).tableCells ?? [];
        for (const cell of cells) {
          visit((cell as { content?: unknown[] }).content);
        }
      }
    }
  };

  visit(body?.content);
  return runs;
}

function flatten(runs: TextRun[]): string {
  return runs.map((r) => r.text).join("");
}

function toDocIndex(runs: TextRun[], flatOffset: number): number {
  for (const run of runs) {
    if (flatOffset < run.flatStart + run.text.length) {
      return run.docStart + (flatOffset - run.flatStart);
    }
  }
  const last = runs[runs.length - 1];
  return last ? last.docEnd : 1;
}

/**
 * The managed region is the span *between* the markers; the markers
 * themselves are left in place so a later render can find them again.
 */
export function findManagedRegion(
  runs: TextRun[],
): { start: number; end: number; text: string } | null {
  const text = flatten(runs);
  const startMarker = text.indexOf(MANAGED_START);
  if (startMarker === -1) return null;
  const contentFlatStart = startMarker + MANAGED_START.length;
  const endMarker = text.indexOf(MANAGED_END, contentFlatStart);
  if (endMarker === -1) return null;

  return {
    start: toDocIndex(runs, contentFlatStart),
    end: toDocIndex(runs, endMarker),
    // Mirrors `wrapManaged`'s framing (a leading/trailing newline around the
    // markdown) so this compares like-for-like against `lastRendered`, which
    // is always the bare markdown we were asked to render.
    text: text.slice(contentFlatStart, endMarker).replace(/^\n/, "").replace(/\n$/, ""),
  };
}

/**
 * A Docs body always ends with a newline that cannot be written past, so the
 * last insertable index is one before the final element's end.
 */
function endOfBody(runs: TextRun[]): number {
  const last = runs[runs.length - 1];
  return last ? Math.max(last.docEnd - 1, 1) : 1;
}
