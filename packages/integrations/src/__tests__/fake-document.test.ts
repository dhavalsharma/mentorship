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
