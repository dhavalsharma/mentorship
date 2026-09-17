import { describe, expect, it } from "vitest";
import type { DocumentAdapter } from "@mentorship/core";
import {
  chooseDocumentConfig,
  documentConfigFromEnv,
} from "../document-config.js";
import { buildLiveRegistry } from "../live-registry.js";

const FULL_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  GOOGLE_ACCESS_TOKEN: "test-token",
  GOOGLE_CALENDAR_ID: "cal_test",
  SANDBOX_ALLOWLIST: "dhavals+mentor@wekancode.com,U-TEST",
};

describe("documentConfigFromEnv", () => {
  it("accepts URLs as well as bare ids", () => {
    expect(
      documentConfigFromEnv({
        GOOGLE_DRIVE_FOLDER_ID: "https://drive.google.com/drive/folders/F1",
        GOOGLE_DRIVE_GUIDELINE_DOC_ID: "https://docs.google.com/document/d/G1/edit",
      }),
    ).toEqual({ folderId: "F1", guidelineDocId: "G1" });
  });

  it("is null without a folder — a guideline alone has nowhere to live", () => {
    expect(
      documentConfigFromEnv({ GOOGLE_DRIVE_GUIDELINE_DOC_ID: "G1" }),
    ).toBeNull();
    expect(documentConfigFromEnv({})).toBeNull();
  });

  it("leaves the guideline off when only a folder is configured", () => {
    expect(documentConfigFromEnv({ GOOGLE_DRIVE_FOLDER_ID: "F1" })).toEqual({
      folderId: "F1",
    });
  });
});

describe("chooseDocumentConfig", () => {
  it("prefers a stored binding row over the environment", () => {
    expect(
      chooseDocumentConfig(
        { folderId: "FROM_DB", guidelineDocId: "DOC_DB" },
        { GOOGLE_DRIVE_FOLDER_ID: "FROM_ENV" },
      ),
    ).toEqual({
      config: { folderId: "FROM_DB", guidelineDocId: "DOC_DB" },
      source: "binding",
    });
  });

  it("does not merge the two sources", () => {
    const resolved = chooseDocumentConfig(
      { folderId: "FROM_DB" },
      { GOOGLE_DRIVE_GUIDELINE_DOC_ID: "DOC_ENV" },
    );
    expect(resolved.config).toEqual({ folderId: "FROM_DB" });
  });

  it("falls back to the environment when the row is absent or empty", () => {
    for (const stored of [undefined, null, {}]) {
      expect(
        chooseDocumentConfig(stored, { GOOGLE_DRIVE_FOLDER_ID: "FROM_ENV" }),
      ).toEqual({ config: { folderId: "FROM_ENV" }, source: "env" });
    }
  });

  it("resolves to nothing when neither source is configured", () => {
    expect(chooseDocumentConfig(undefined, {})).toEqual({
      config: null,
      source: "none",
    });
  });
});

describe("buildLiveRegistry document slot", () => {
  it("binds the real Drive adapter when a folder is configured", () => {
    const { registry } = buildLiveRegistry({
      ...FULL_ENV,
      GOOGLE_DRIVE_FOLDER_ID: "F1",
    });
    expect(registry.get<DocumentAdapter>("document")!.id).toBe("google-drive");
  });

  it("binds the real Drive adapter from a resolved binding config", () => {
    const { registry } = buildLiveRegistry(FULL_ENV, undefined, {
      folderId: "F_DB",
    });
    expect(registry.get<DocumentAdapter>("document")!.id).toBe("google-drive");
  });

  it("stays on the fake when nothing names a folder", () => {
    const { registry } = buildLiveRegistry(FULL_ENV);
    expect(registry.get<DocumentAdapter>("document")!.id).toBe("fake-doc");
  });
});
