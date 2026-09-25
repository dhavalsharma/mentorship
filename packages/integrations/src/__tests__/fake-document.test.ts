import { describe, expect, it } from "vitest";
import { FakeDocument, Recorder, wrapManaged } from "@mentorship/integrations";

/**
 * The fake is what the demo and every saga test render into, so the properties
 * asserted here are the ones those tests are entitled to rely on — including
 * that the pair ends up with edit access, which is otherwise only visible
 * against a live Drive account nothing in this repo can reach.
 */

const PAIR = [{ email: "arjun@x.com" }, { email: "priya@x.com" }];

describe("FakeDocument", () => {
  it("records the collaborators the render was given", async () => {
    const doc = new FakeDocument(new Recorder());

    const { docRef } = await doc.renderManagedRegion({
      docRef: null,
      title: "t",
      markdown: "## Session 1",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    expect(doc.read(docRef)).toBe(wrapManaged("## Session 1"));
    expect(doc.sharedWith(docRef)).toEqual(["arjun@x.com", "priya@x.com"]);
  });

  it("accumulates without duplicating across re-renders", async () => {
    const doc = new FakeDocument(new Recorder());

    await doc.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: [PAIR[0]!],
      idempotencyKey: "k1",
    });
    await doc.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "two",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(doc.sharedWith("doc_1")).toEqual(["arjun@x.com", "priya@x.com"]);
  });

  it("ignores an empty email rather than recording a share to nobody", async () => {
    const doc = new FakeDocument(new Recorder());

    await doc.renderManagedRegion({
      docRef: "doc_1",
      title: "t",
      markdown: "one",
      collaborators: [{ email: "  " }, ...PAIR],
      idempotencyKey: "k1",
    });

    expect(doc.sharedWith("doc_1")).toEqual(["arjun@x.com", "priya@x.com"]);
  });

  it("reports an unknown doc as shared with nobody", () => {
    expect(new FakeDocument(new Recorder()).sharedWith("nope")).toEqual([]);
  });
});

/**
 * ADR-0005's two safeguards: echo suppression (a revision that is our own
 * prior write reappearing must never be mistaken for a human edit) and
 * pinning (a genuine human edit inside the managed region is preserved, not
 * clobbered, on the next render).
 */
describe("FakeDocument echo suppression and pinning", () => {
  it("re-renders normally when nobody has touched the region", async () => {
    const doc = new FakeDocument(new Recorder());

    const first = await doc.renderManagedRegion({
      docRef: null,
      title: "t",
      markdown: "## Session 1",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });
    expect(first.pinned).toBe(false);

    const second = await doc.renderManagedRegion({
      docRef: first.docRef,
      title: "t",
      markdown: "## Session 2",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(second.pinned).toBe(false);
    expect(doc.read(first.docRef)).toBe(wrapManaged("## Session 2"));
  });

  it("does not pin when the divergence is our own echo, not a human edit", async () => {
    const doc = new FakeDocument(new Recorder());

    const { docRef } = await doc.renderManagedRegion({
      docRef: null,
      title: "t",
      markdown: "## Session 1",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    // Stand-in for the vendor reformatting our own write (e.g. whitespace
    // normalization on save) — the bytes differ from what we rendered, but
    // the revision is still authored by us.
    doc.simulateServiceEcho(docRef, "## Session 1 (reformatted)");

    const rerender = await doc.renderManagedRegion({
      docRef,
      title: "t",
      markdown: "## Session 2",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(rerender.pinned).toBe(false);
    expect(doc.read(docRef)).toBe(wrapManaged("## Session 2"));
  });

  it("pins a genuine human edit and preserves it on the next render", async () => {
    const doc = new FakeDocument(new Recorder());

    const { docRef } = await doc.renderManagedRegion({
      docRef: null,
      title: "t",
      markdown: "## Session 1",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });

    doc.humanEdit(docRef, "## Session 1\n\nArjun: adding my own note here.");

    const rerender = await doc.renderManagedRegion({
      docRef,
      title: "t",
      markdown: "## Session 2",
      collaborators: PAIR,
      idempotencyKey: "k2",
    });

    expect(rerender.pinned).toBe(true);
    // The human's own text survives, byte for byte — the render is skipped
    // entirely rather than partially applied.
    expect(doc.read(docRef)).toBe(
      wrapManaged("## Session 1\n\nArjun: adding my own note here."),
    );
    expect(doc.read(docRef)).not.toContain("## Session 2");
  });

  it("stays pinned across repeated renders until the divergence is resolved", async () => {
    const doc = new FakeDocument(new Recorder());

    const { docRef } = await doc.renderManagedRegion({
      docRef: null,
      title: "t",
      markdown: "## Session 1",
      collaborators: PAIR,
      idempotencyKey: "k1",
    });
    doc.humanEdit(docRef, "human override");

    for (const markdown of ["## Session 2", "## Session 3"]) {
      const result = await doc.renderManagedRegion({
        docRef,
        title: "t",
        markdown,
        collaborators: PAIR,
        idempotencyKey: markdown,
      });
      expect(result.pinned).toBe(true);
    }

    expect(doc.read(docRef)).toBe(wrapManaged("human override"));
  });
});

/**
 * Invariant 6 for the document slot (journey-suite bug #8): a first render
 * retried after a crash — same key, still no doc id, because the
 * `document.rendered` that would have carried it never committed — must land
 * in the doc the first attempt created, mirroring the Drive adapter's
 * key-tagged lookup.
 */
describe("FakeDocument creation is idempotent by key", () => {
  const first = {
    docRef: null,
    title: "Arjun & Priya — session notes",
    markdown: "## Session 1",
    collaborators: PAIR,
    idempotencyKey: "saga:1:4:0",
  };

  it("a retried first render reuses the doc it already created", async () => {
    const recorder = new Recorder();
    const doc = new FakeDocument(recorder);

    const a = await doc.renderManagedRegion(first);
    const b = await doc.renderManagedRegion(first);

    expect(b).toEqual(a);
    // Nothing a participant could see happened twice: one doc, one render.
    expect(recorder.of("document.rendered")).toHaveLength(1);
    expect(doc.read("doc_2")).toBeUndefined();
  });

  it("a different key is a different render, and a different pair's first render a different doc", async () => {
    const doc = new FakeDocument(new Recorder());

    const a = await doc.renderManagedRegion(first);
    const b = await doc.renderManagedRegion({ ...first, idempotencyKey: "saga:2:4:0" });

    expect(b.docRef).not.toBe(a.docRef);
  });

  it("a replayed key does not paper over a human edit made since", async () => {
    const doc = new FakeDocument(new Recorder());
    const a = await doc.renderManagedRegion(first);
    doc.humanEdit(a.docRef, "human override");

    const b = await doc.renderManagedRegion({ ...first, docRef: a.docRef });

    expect(b.docRef).toBe(a.docRef);
    expect(b.pinned).toBe(true);
    expect(doc.read(a.docRef)).toBe(wrapManaged("human override"));
  });
});
