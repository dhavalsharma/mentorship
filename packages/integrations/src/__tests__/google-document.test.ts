import { describe, expect, it } from "vitest";
import {
  extractDriveFolderId,
  extractGoogleDocId,
  GoogleDriveDocumentAdapter,
  MANAGED_END,
  MANAGED_START,
  type ReplayedCall,
} from "@mentorship/integrations";
import { openReplay, warnOnStaleFixtures } from "./vendor-replay.js";

/**
 * No network. The transport replays `tests/fixtures/vendor/google-{drive,docs}`
 * (tier 4, docs/e2e-testing-strategy.md), with handlers layering an in-memory
 * document on top of the recorded responses — which is what makes the one
 * property that actually matters testable: a re-render replaces the managed
 * region and leaves everything around it byte-identical (ADR-0005). The
 * replay refuses any request field and any response field no fixture has
 * recorded, so the in-memory document can only describe the API the fixtures
 * describe.
 */

warnOnStaleFixtures("google-document.test.ts");

type Call = ReplayedCall;

/**
 * Builds a Docs body out of a plain string, one text run per line. Document
 * indices start at 1 and advance by the run's length, which is the coordinate
 * system the adapter has to map back into. Every fixture here ends in a
 * newline because a real Docs body always does — that final newline is the
 * one index nothing may be written past, and a fixture without it would
 * describe a document that cannot exist. The leading element is the
 * `sectionBreak` the recorded `documents.get` starts with, as every real Docs
 * body does; the hand-written stub this replaced never had one.
 */
function bodyFromText(text: string, sectionBreak: unknown): { content: unknown[] } {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let index = 1;
  const content = lines.map((line) => {
    const raw = `${line}\n`;
    const startIndex = index;
    index += raw.length;
    return {
      startIndex,
      endIndex: index,
      paragraph: {
        elements: [{ startIndex, endIndex: index, textRun: { content: raw, textStyle: {} } }],
      },
    };
  });
  return { content: sectionBreak ? [sectionBreak, ...content] : content };
}

function recordedSectionBreak(response: Record<string, unknown>): unknown {
  const first = (response["body"] as { content?: Record<string, unknown>[] } | undefined)
    ?.content?.[0];
  return first && "sectionBreak" in first ? first : undefined;
}

function applyRequests(text: string, requests: unknown[]): string {
  // Docs indices are 1-based over the body; the flat string here is 0-based.
  let out = text;
  for (const request of requests) {
    const r = request as Record<string, Record<string, never>>;
    const del = r["deleteContentRange"] as
      | { range: { startIndex: number; endIndex: number } }
      | undefined;
    if (del) {
      out = out.slice(0, del.range.startIndex - 1) + out.slice(del.range.endIndex - 1);
    }
    const ins = r["insertText"] as
      | { location: { index: number }; text: string }
      | undefined;
    if (ins) {
      out = out.slice(0, ins.location.index - 1) + ins.text + out.slice(ins.location.index - 1);
    }
  }
  return out;
}

function stubTransport(
  initial: {
    docText?: string;
    permissions?: { emailAddress: string; role: string }[];
    /** Who authored the current revision before any call is made. */
    revisionAuthor?: "service" | "human";
    /** Files already in the folder, for the adopt-don't-duplicate path. */
    existingFiles?: DriveFile[];
  } = {},
) {
  const replay = openReplay();
  let text = initial.docText ?? "";
  let revisionCounter = 1;
  let revisionAuthor: "service" | "human" = initial.revisionAuthor ?? "service";
  const permissions = [...(initial.permissions ?? [])];
  const files: DriveFile[] = [...(initial.existingFiles ?? [])];
  const created = (body: unknown, id: string): { id: string } => {
    const b = body as { name: string; appProperties?: Record<string, string> };
    files.push({ id, name: b.name, ...(b.appProperties ? { appProperties: b.appProperties } : {}) });
    return { id };
  };

  replay
    .on("revisions.list", ({ response }) => {
      // The recorded entry's shape, with `me` set by who wrote last here —
      // which is exactly the field nobody has confirmed Drive reports.
      const recorded = response["revisions"] as { lastModifyingUser: { me: boolean } }[];
      const last = structuredClone(recorded[recorded.length - 1]!);
      last.lastModifyingUser.me = revisionAuthor === "service";
      return { ...response, revisions: [last] };
    })
    .on("permissions.list", ({ response }) => ({ ...response, permissions: [...permissions] }))
    .on("permissions.create", ({ request, response }) => {
      const body = request.body as { emailAddress: string; role: string };
      permissions.push({ emailAddress: body.emailAddress, role: body.role });
      return response;
    })
    .on("files.list", ({ request, response }) => ({
      ...response,
      files: files.filter(matchesQuery(String(request.query?.["q"] ?? ""))).map((f) => ({ id: f.id })),
    }))
    .on("files.copy", ({ request, response }) =>
      created(request.body, `${String(response["id"])}${files.length === 0 ? "" : `_${files.length}`}`),
    )
    .on("files.create", ({ request, response }) =>
      created(request.body, `${String(response["id"])}${files.length === 0 ? "" : `_${files.length}`}`),
    )
    .on("documents.batchUpdate", ({ request, response }) => {
      const { requests } = request.body as { requests: unknown[] };
      text = applyRequests(text, requests);
      revisionAuthor = "service";
      revisionCounter++;
      return { ...response, writeControl: { requiredRevisionId: `rev${revisionCounter}` } };
    })
    .on("documents.get", ({ response }) => ({
      ...response,
      revisionId: `rev${revisionCounter}`,
      body: bodyFromText(text, recordedSectionBreak(response)),
    }));

  return {
    replay,
    call: replay.googleDocs(),
    calls: replay.calls,
    files: () => files,
    text: () => text,
    /** Test hook: a human edits the doc directly, out of band from any render. */
    humanEdit: (newText: string) => {
      text = newText;
      revisionAuthor = "human";
      revisionCounter++;
    },
    /**
     * Test hook: the doc's bytes change (e.g. Drive reformatting on save) but
     * the revision is still ours — the case echo suppression must not confuse
     * with a human edit.
     */
    serviceEcho: (newText: string) => {
      text = newText;
      revisionAuthor = "service";
      revisionCounter++;
    },
  };
}

interface DriveFile {
  id: string;
  name: string;
  appProperties?: Record<string, string>;
}

/**
 * Just enough of Drive's query language to answer the two lookups the Drive
 * adapters make: by name, and by an `appProperties` entry. Everything else
 * in the `q` (`in parents`, `trashed`, `mimeType`) holds for every file in
 * this stub by construction.
 */
function matchesQuery(q: string): (f: DriveFile) => boolean {
  const unescape = (v: string) => v.replace(/\\(.)/g, "$1");
  const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
  const prop = /appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/.exec(q);
  return (f) =>
    (!name || f.name === unescape(name[1]!)) &&
    (!prop || f.appProperties?.[unescape(prop[1]!)] === unescape(prop[2]!));
}

const CONFIG = { folderId: "folder_1" };
const PAIR = [{ email: "arjun@x.com" }, { email: "priya@x.com" }];

describe("GoogleDriveDocumentAdapter", () => {
  it("probes the configured folder and reports anchored edits", async () => {
    const { call, calls } = stubTransport();
    const caps = await new GoogleDriveDocumentAdapter(call, CONFIG).probe();

    expect(caps.anchoredDocEdits).toBe(true);
    expect(calls[0]).toMatchObject({ api: "drive", path: "/files/folder_1" });
  });

  it("copies the guideline doc into the folder on first render", async () => {
    const { call, calls, replay } = stubTransport();
    const adapter = new GoogleDriveDocumentAdapter(call, {
      ...CONFIG,
      guidelineDocId: "guideline_1",
    });

    const result = await adapter.renderManagedRegion({
      docRef: null,
      title: "Arjun & Priya — session notes",
      markdown: "first",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    const copy = calls.find((c) => c.path.endsWith("/copy"));
    expect(copy?.body).toEqual({
      name: "Arjun & Priya — session notes",
      parents: ["folder_1"],
      // The render's key goes onto the file itself, so a retry can find it.
      appProperties: { mentorshipIdempotencyKey: "k1" },
    });
    const copiedId = replay.fixture("files.copy").response!["id"];
    expect(result.docRef).toBe(copiedId);
    expect(result.url).toBe(`https://docs.google.com/document/d/${copiedId}/edit`);
    expect(result.revisionId).toBe("rev2");
  });

  it("creates a blank doc inside the folder, key attached, in one call when no guideline is configured", async () => {
    const { call, calls, replay } = stubTransport();
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    const result = await adapter.renderManagedRegion({
      docRef: null,
      title: "Blank pair",
      markdown: "first",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    expect(calls.some((c) => c.path.endsWith("/copy"))).toBe(false);
    const create = calls.find((c) => c.call === "files.create");
    expect(create?.body).toEqual({
      name: "Blank pair",
      mimeType: "application/vnd.google-apps.document",
      parents: ["folder_1"],
      appProperties: { mentorshipIdempotencyKey: "k1" },
    });
    // One atomic create: no create-then-move, so there is no window in which
    // the doc exists outside the folder or without its key.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.api === "docs" && c.path === "/documents")).toBe(false);
    expect(result.docRef).toBe(replay.fixture("files.create").response!["id"]);
  });

  it("looks the key up inside the folder before creating anything", async () => {
    const { call, calls } = stubTransport();

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: null,
      title: "Arjun & Priya",
      markdown: "x",
      collaborators: PAIR,
      idempotencyKey: "saga:abc:4:0",
    });

    const lookup = calls.findIndex((c) => c.call === "files.list");
    const create = calls.findIndex((c) => c.call === "files.create");
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeLessThan(create);
    expect(calls[lookup]!.query).toMatchObject({
      q:
        "'folder_1' in parents and appProperties has { key='mentorshipIdempotencyKey' and " +
        "value='saga:abc:4:0' } and trashed = false",
      orderBy: "createdTime",
    });
  });

  // Bug #8: the first attempt created the doc and the process died before
  // `document.rendered` committed, so the retry arrives with no doc id and
  // the same key.
  it.each([
    ["from the guideline", { ...CONFIG, guidelineDocId: "guideline_1" }],
    ["blank", CONFIG],
  ])("a retried first render (%s) adopts the doc its first attempt created", async (_, config) => {
    const { call, calls, files } = stubTransport({ docText: "\n" });
    const render = {
      docRef: null,
      title: "Arjun & Priya — session notes",
      markdown: "x",
      collaborators: PAIR,
      idempotencyKey: "saga:abc:4:0",
    };

    const first = await new GoogleDriveDocumentAdapter(call, config).renderManagedRegion(render);
    // A fresh adapter: a restarted worker has none of the first one's memory.
    const retry = await new GoogleDriveDocumentAdapter(call, config).renderManagedRegion(render);

    expect(retry.docRef).toBe(first.docRef);
    expect(files()).toHaveLength(1);
    expect(calls.filter((c) => c.call === "files.copy" || c.call === "files.create")).toHaveLength(1);
    // And the pair is not sent Drive's access email a second time.
    expect(calls.filter((c) => c.call === "permissions.create")).toHaveLength(2);
  });

  it("never adopts another pair's doc just because it has the same name", async () => {
    const { call, calls } = stubTransport({
      docText: "\n",
      existingFiles: [
        {
          id: "other_pairs_doc",
          name: "Arjun & Priya",
          appProperties: { mentorshipIdempotencyKey: "saga:other:4:0" },
        },
      ],
    });

    const result = await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: null,
      title: "Arjun & Priya",
      markdown: "x",
      collaborators: PAIR,
      idempotencyKey: "saga:abc:4:0",
    });

    expect(result.docRef).not.toBe("other_pairs_doc");
    expect(calls.some((c) => c.call === "files.create")).toBe(true);
  });

  it("hashes a key too long for a Drive app property rather than failing the create", async () => {
    const { call, calls } = stubTransport();
    const longKey = `saga:${"x".repeat(200)}:4:0`;

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: null,
      title: "t",
      markdown: "x",
      collaborators: [],
      idempotencyKey: longKey,
    });

    const tag = (calls.find((c) => c.call === "files.create")!.body as {
      appProperties: Record<string, string>;
    }).appProperties["mentorshipIdempotencyKey"]!;
    expect(tag).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Drive's limit: key + value at most 124 bytes.
    expect(Buffer.byteLength(`mentorshipIdempotencyKey${tag}`)).toBeLessThanOrEqual(124);
    expect(String(calls.find((c) => c.call === "files.list")!.query!["q"])).toContain(tag);
  });

  it("seeds the markers at the end of a doc that has none", async () => {
    const guideline = "How to use this doc\nBring an agenda.\n";
    const { call, text } = stubTransport({ docText: guideline });

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "## Session 1",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    expect(text()).toContain(guideline);
    expect(text()).toContain(MANAGED_START);
    expect(text()).toContain("## Session 1");
    expect(text()).toContain(MANAGED_END);
  });

  it("replaces only the managed region, leaving the pair's own text untouched", async () => {
    const before = [
      "Guideline heading",
      "",
      MANAGED_START,
      "## Session 1",
      MANAGED_END,
      "",
      "Priya's private scratch notes",
      "",
    ].join("\n");
    const { call, text } = stubTransport({ docText: before });

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "## Session 2\n- action item",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    const after = text();
    expect(after.startsWith("Guideline heading")).toBe(true);
    expect(after.endsWith("Priya's private scratch notes\n")).toBe(true);
    expect(after).toContain("## Session 2");
    expect(after).not.toContain("## Session 1");
    // Exactly one managed region, still delimited by both markers.
    expect(after.split(MANAGED_START)).toHaveLength(2);
    expect(after.split(MANAGED_END)).toHaveLength(2);
  });

  it("is stable across repeated renders", async () => {
    const before = [MANAGED_START, "old", MANAGED_END, "kept", ""].join("\n");
    const { call, text } = stubTransport({ docText: before });
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    for (const markdown of ["one", "two", "three"]) {
      await adapter.renderManagedRegion({
        docRef: "doc_1",
        title: "t",
        markdown,
        collaborators: PAIR,
        idempotencyKey: markdown,
      });
    }

    expect(text()).toBe(
      [MANAGED_START, "three", MANAGED_END, "kept", ""].join("\n"),
    );
  });
});

/**
 * Nothing else grants the pair access to their own doc: the folder's sharing
 * is whatever the admin happened to set, and `files.copy` does not carry the
 * guideline doc's permissions onto the copy.
 */
describe("sharing the running doc with the pair", () => {
  const grants = (calls: Call[]) =>
    calls
      .filter((c) => c.path.endsWith("/permissions") && c.method === "POST")
      .map((c) => c.body as { emailAddress: string; role: string; type: string });

  it("grants writer access to every collaborator on a fresh doc", async () => {
    const { call, calls } = stubTransport();

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: null,
      title: "Fresh",
      markdown: "first",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    expect(grants(calls)).toEqual([
      { role: "writer", type: "user", emailAddress: "arjun@x.com" },
      { role: "writer", type: "user", emailAddress: "priya@x.com" },
    ]);
    // The one notification a participant should get about this doc.
    const first = calls.find(
      (c) => c.path.endsWith("/permissions") && c.method === "POST",
    );
    expect(first?.query).toMatchObject({ sendNotificationEmail: "true" });
  });

  it("does not re-grant someone who already has access", async () => {
    const { call, calls } = stubTransport({
      docText: [MANAGED_START, "old", MANAGED_END, ""].join("\n"),
      permissions: [
        { emailAddress: "arjun@x.com", role: "writer" },
        { emailAddress: "admin@x.com", role: "owner" },
      ],
    });

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "next",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(
      calls.some((c) => c.path.endsWith("/permissions") && c.method === "GET"),
    ).toBe(true);
    expect(grants(calls)).toEqual([
      { role: "writer", type: "user", emailAddress: "priya@x.com" },
    ]);
  });

  it("sends nothing at all on a later render once both are writers", async () => {
    const { call, calls } = stubTransport({
      docText: [MANAGED_START, "old", MANAGED_END, ""].join("\n"),
    });
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    for (const markdown of ["one", "two", "three"]) {
      await adapter.renderManagedRegion({
        docRef: "doc_1",
        title: "t",
        markdown,
        collaborators: PAIR,
        idempotencyKey: markdown,
      });
    }

    // Two grants total across three renders — the stub remembers them, so a
    // repeat render re-sending Drive's access email would show up here.
    expect(grants(calls)).toHaveLength(2);
  });

  it("skips an unusable email and still renders for the rest of the pair", async () => {
    const { call, calls, text } = stubTransport();
    const warnings: { message: string; detail?: Record<string, unknown> }[] = [];

    await new GoogleDriveDocumentAdapter(call, CONFIG, (message, detail) =>
      warnings.push({ message, ...(detail ? { detail } : {}) }),
    ).renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "## Session 1",
      collaborators: [{ email: "  " }, { email: "not-an-email" }, ...PAIR],
      idempotencyKey: "k1",
    });

    expect(grants(calls).map((g) => g.emailAddress)).toEqual([
      "arjun@x.com",
      "priya@x.com",
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.message).toBe("document not shared: unusable email");
    expect(text()).toContain("## Session 1");
  });

  it("does not list permissions when there is nobody to grant", async () => {
    const { call, calls } = stubTransport();

    await new GoogleDriveDocumentAdapter(call, CONFIG).renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "x",
      collaborators: [],
      idempotencyKey: "k1",
    });

    expect(calls.some((c) => c.path.endsWith("/permissions"))).toBe(false);
  });
});

/**
 * ADR-0005's two safeguards, against the real write path (Docs `batchUpdate`
 * + Drive `revisions.list`) rather than the in-memory `FakeDocument`.
 */
describe("echo suppression and pinning", () => {
  it("re-renders normally when nobody has touched the region", async () => {
    const before = [MANAGED_START, "old", MANAGED_END, "kept", ""].join("\n");
    const { call, text } = stubTransport({ docText: before });
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    const first = await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });
    expect(first.pinned).toBe(false);

    const second = await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "two",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(second.pinned).toBe(false);
    expect(text()).toBe([MANAGED_START, "two", MANAGED_END, "kept", ""].join("\n"));
  });

  it("does not pin when the diverging revision is our own echo", async () => {
    const before = [MANAGED_START, "old", MANAGED_END, "kept", ""].join("\n");
    const { call, text, serviceEcho } = stubTransport({ docText: before });
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    // Stand-in for Drive reformatting our own write on save: the bytes in
    // the region differ from what we rendered, but the revision is still us.
    serviceEcho([MANAGED_START, "one (reformatted)", MANAGED_END, "kept", ""].join("\n"));

    const rerender = await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "two",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(rerender.pinned).toBe(false);
    expect(text()).toBe([MANAGED_START, "two", MANAGED_END, "kept", ""].join("\n"));
  });

  it("pins a genuine human edit inside the managed region", async () => {
    const before = [MANAGED_START, "old", MANAGED_END, "kept", ""].join("\n");
    const { call, text, humanEdit } = stubTransport({ docText: before });
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    humanEdit(
      [MANAGED_START, "one\n\nArjun: adding my own note.", MANAGED_END, "kept", ""].join("\n"),
    );

    const rerender = await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "two",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(rerender.pinned).toBe(true);
    // Nothing was written: the human's own text is exactly what it was,
    // never partially applied, never overwritten.
    expect(text()).toBe(
      [MANAGED_START, "one\n\nArjun: adding my own note.", MANAGED_END, "kept", ""].join("\n"),
    );
  });

  it("stays pinned across repeated renders until the divergence is resolved", async () => {
    const before = [MANAGED_START, "old", MANAGED_END, "kept", ""].join("\n");
    const { call, text, humanEdit } = stubTransport({ docText: before });
    const adapter = new GoogleDriveDocumentAdapter(call, CONFIG);

    await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });
    humanEdit([MANAGED_START, "human override", MANAGED_END, "kept", ""].join("\n"));

    for (const markdown of ["two", "three"]) {
      const result = await adapter.renderManagedRegion({
        docRef: "doc_1",
        title: "t",
        markdown,
        collaborators: PAIR,
        idempotencyKey: markdown,
      });
      expect(result.pinned).toBe(true);
    }

    expect(text()).toBe(
      [MANAGED_START, "human override", MANAGED_END, "kept", ""].join("\n"),
    );
  });
});

/**
 * No state, no handlers for the parts under test: the responses are the
 * fixtures exactly as recorded. When these fixtures are replaced by live
 * captures, these are the tests whose meaning changes from "the adapter agrees
 * with what we wrote down" to "the adapter agrees with Google".
 */
describe("against the fixtures as recorded", () => {
  it("seeds the markers just before the final newline of the recorded body", async () => {
    const replay = openReplay();
    await new GoogleDriveDocumentAdapter(replay.googleDocs(), CONFIG).renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "## Session 1",
      collaborators: [],
      idempotencyKey: "k1",
    });

    // The recorded body is a sectionBreak followed by two paragraphs; the
    // last insertable index is one before the final paragraph's endIndex.
    const content = (replay.fixture("documents.get").response!["body"] as {
      content: { endIndex: number }[];
    }).content;
    const lastEnd = content[content.length - 1]!.endIndex;
    const write = replay.calls.find((c) => c.call === "documents.batchUpdate")!;
    const [insert] = (write.body as { requests: { insertText: { location: { index: number } } }[] })
      .requests;
    expect(insert!.insertText.location.index).toBe(lastEnd - 1);
  });

  it("reads the recorded revisions.list's last entry as the current revision", async () => {
    // The recorded list's last entry reports `me: true`, so a divergent
    // region is treated as our own echo and overwritten, not pinned. Whether
    // Drive really reports `me` this way is the unverified part — which is
    // why this fixture is the first one the live suite replaces.
    const replay = openReplay();
    let text = [MANAGED_START, "one", MANAGED_END, ""].join("\n");
    replay
      .on("documents.get", ({ response }) => ({
        ...response,
        body: bodyFromText(text, recordedSectionBreak(response)),
      }))
      .on("documents.batchUpdate", ({ request, response }) => {
        text = applyRequests(text, (request.body as { requests: unknown[] }).requests);
        return response;
      });
    const adapter = new GoogleDriveDocumentAdapter(replay.googleDocs(), CONFIG);
    await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: [],
      idempotencyKey: "k1",
    });
    text = [MANAGED_START, "one, reformatted", MANAGED_END, ""].join("\n");

    const result = await adapter.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "two",
      collaborators: [],
      idempotencyKey: "k2",
    });

    expect(replay.calls.some((c) => c.call === "revisions.list")).toBe(true);
    expect(result.pinned).toBe(false);
    expect(text).toContain("two");
  });

  it("surfaces Drive's recorded refusal of a plus-addressed share rather than swallowing it", async () => {
    // docs/live-tenant-testing.md: `name+role@domain` gets 400
    // invalidSharingRequest while the bare address succeeds. The adapter's
    // local EMAIL check passes a plus address, so the refusal reaches the
    // caller — and, because access is granted before the write, the render
    // does not happen. Recorded here as current behaviour, not endorsed.
    const replay = openReplay().use("permissions.create", "error-plus-addressed");
    await expect(
      new GoogleDriveDocumentAdapter(replay.googleDocs(), CONFIG).renderManagedRegion({
        docRef: "doc_1",
        title: "t",
        markdown: "x",
        collaborators: [{ email: "someone+mentor@example.com" }],
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/invalidSharingRequest/);
    expect(replay.calls.some((c) => c.call === "documents.batchUpdate")).toBe(false);
  });
});

describe("id extraction", () => {
  it("accepts a folder URL or a bare id", () => {
    expect(
      extractDriveFolderId("https://drive.google.com/drive/folders/1AbC_-dEf"),
    ).toBe("1AbC_-dEf");
    expect(extractDriveFolderId("  1AbC_-dEf  ")).toBe("1AbC_-dEf");
    expect(extractDriveFolderId("")).toBeNull();
    expect(extractDriveFolderId("not a folder url")).toBeNull();
  });

  it("accepts a doc URL or a bare id", () => {
    expect(
      extractGoogleDocId("https://docs.google.com/document/d/1XyZ-9/edit?tab=t.0"),
    ).toBe("1XyZ-9");
    expect(extractGoogleDocId("1XyZ-9")).toBe("1XyZ-9");
    expect(extractGoogleDocId("https://example.com/nope")).toBeNull();
  });
});
