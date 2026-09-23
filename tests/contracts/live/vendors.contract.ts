import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CalendarAdapter,
  ConversationAdapter,
  DmAdapter,
  DocumentAdapter,
  SheetAdapter,
  ThreadRef,
} from "@mentorship/core";
import { SandboxGuard } from "@mentorship/integrations";
import { buildLiveRegistry } from "../../../apps/worker/src/live-registry.js";
import { requireLiveContractEnv } from "./env.js";

/**
 * Tier 4, mechanism 3: contract tests against a live sandbox, on demand,
 * never in the PR gate (docs/e2e-testing-strategy.md, docs/vendor-contracts.md).
 *
 * Run only through `pnpm test:contracts:live`, which refuses to start without
 * credentials and an allowlist. Every adapter comes from `buildLiveRegistry`,
 * so every call that addresses a person goes through `SandboxGuard` exactly
 * as in `pnpm serve:worker:live`; the handful of raw transport calls below
 * (which exist only to observe a vendor fact no adapter method exposes) are
 * checked against the same guard by hand first. Capture is forced on: every
 * request/response is written to tests/fixtures/vendor as `source: "live"`,
 * replacing the hand-written fixtures the adapter tests replay.
 *
 * What it leaves behind, on purpose, in the sandbox only: a few bot messages
 * in the pair's group DM and one member's DM, one unmailed event on the
 * dedicated calendar, one doc and one spreadsheet in the configured folder.
 * Nothing here deletes anything.
 */

const env = requireLiveContractEnv();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const refused: string[] = [];

const built = buildLiveRegistry(
  { ...env, CAPTURE_VENDOR_FIXTURES: "1" },
  (detail) => refused.push(`${detail.adapter}: ${detail.refused.join(", ")}`),
  { folderId: env.GOOGLE_DRIVE_FOLDER_ID },
  { folderId: env.GOOGLE_SHEETS_FOLDER_ID ?? env.GOOGLE_DRIVE_FOLDER_ID },
);
const { registry, transports } = built;
// The same allowlist, for the raw transport calls that sit beside the adapters.
const guard = new SandboxGuard({ allowlist: env.SANDBOX_ALLOWLIST.split(",") });

afterAll(() => {
  console.log(
    `\nlive vendor contracts: captured ${built.capturedFixtures.length} fixture file(s):\n` +
      built.capturedFixtures.map((f) => `  ${f}`).join("\n") +
      "\nReview the diff (redaction is automatic but not infallible), commit it, and update the " +
      "sign-off dates in docs/vendor-contracts.md." +
      (refused.length > 0 ? `\nSandboxGuard refused: ${refused.join("; ")}` : ""),
  );
});

describe("Slack", () => {
  const conversation = () => registry.get<ConversationAdapter>("conversation")!;
  let thread: ThreadRef;

  beforeAll(async () => {
    thread = await conversation().ensureThread({
      pairingId: `contract-${stamp}`,
      memberRefs: env.slackMembers.slice(0, 2),
      title: "contract run",
    });
  });

  it("auth.test: the token works and the bot is installed", async () => {
    await expect(conversation().probe()).resolves.toMatchObject({ threadedConversation: true });
  });

  it("conversations.open: a group DM for two allowlisted members", () => {
    expect(thread.channelId).toMatch(/^[CDG][A-Z0-9]+$/);
  });

  it("chat.postMessage: plain, proposal and confirmation shapes all return a ts", async () => {
    const ts = /^\d+\.\d+$/;
    const plain = await conversation().postMessage({
      thread,
      body: `[contract run ${stamp}] plain message`,
      idempotencyKey: `contract:${stamp}:plain`,
    });
    const proposal = await conversation().postProposal({
      thread,
      agreementId: `agr_contract_${stamp}`,
      options: [
        {
          optionId: "opt_1",
          startsAt: "2030-01-01T09:00:00.000Z",
          endsAt: "2030-01-01T09:30:00.000Z",
          label: "contract-run option (do not click)",
        },
      ],
      body: `[contract run ${stamp}] proposal shape`,
      idempotencyKey: `contract:${stamp}:proposal`,
    });
    const confirmation = await conversation().postConfirmation({
      thread,
      extractionId: `ext_contract_${stamp}`,
      docUrl: "https://example.com/contract-run",
      body: `[contract run ${stamp}] confirmation shape (do not click)`,
      idempotencyKey: `contract:${stamp}:confirm`,
    });
    expect(plain.messageRef).toMatch(ts);
    expect(proposal.messageRef).toMatch(ts);
    expect(confirmation.messageRef).toMatch(ts);
  });

  it("dm: chat.postMessage straight to a member id", async () => {
    const sent = await registry.get<DmAdapter>("dm")!.send({
      memberRef: env.slackMembers[0]!,
      body: `[contract run ${stamp}] private message shape`,
      idempotencyKey: `contract:${stamp}:dm`,
    });
    expect(sent.messageRef).toMatch(/^\d+\.\d+$/);
  });

  it("mpim:history: the bot can read back the pair's group DM", async () => {
    // Outbound proof of the scope only. Whether Slack *delivers* message.mpim
    // events to /slack/events needs a human typing in the thread with
    // apps/api reachable — see docs/vendor-contracts.md.
    const res = await transports.slack("conversations.history", { channel: thread.channelId, limit: 5 });
    expect(Array.isArray(res["messages"])).toBe(true);
  });

  it("im:history: the bot can read back a 1:1 DM", async () => {
    const member = env.slackMembers[0]!;
    guard.check("contract.conversations.open", [member]);
    const opened = await transports.slack("conversations.open", { users: member });
    const channel = (opened["channel"] as { id: string }).id;
    const res = await transports.slack("conversations.history", { channel, limit: 5 });
    expect(Array.isArray(res["messages"])).toBe(true);
  });
});

describe("Google Calendar", () => {
  const calendar = () => registry.get<CalendarAdapter>("calendar")!;
  const attendee = () => env.emails[0]!;

  it("calendarList.list: probe", async () => {
    await expect(calendar().probe()).resolves.toMatchObject({ freeBusy: true });
  });

  it("freebusy.query: an allowlisted attendee", async () => {
    const busy = await calendar().freeBusy({
      memberRefs: [attendee()],
      window: {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(Array.isArray(busy[attendee()])).toBe(true);
  });

  it("events.insert + events.get: idempotency-keyed id, sendUpdates none, read back", async () => {
    const key = `contract:${stamp}:book`;
    const input = {
      memberRefs: [attendee()],
      start: "2030-01-01T09:00:00.000Z",
      end: "2030-01-01T09:30:00.000Z",
      title: `[contract run ${stamp}]`,
      description: "Created by pnpm test:contracts:live with sendUpdates=none.",
      withConference: true,
      withTranscription: false,
      idempotencyKey: key,
    };
    const created = await calendar().createEvent(input);
    const read = await calendar().getEvent(created.eventId);
    expect(read?.eventId).toBe(created.eventId);

    // What does Google do with a retried insert under the same id? The
    // adapter's comment says the key "makes a retried effect a no-op", but
    // that has never been observed. Record whichever it is, rather than
    // assert the answer we hope for.
    const retry = await calendar()
      .createEvent(input)
      .then((ref) => ({ outcome: "resolved" as const, eventId: ref.eventId }))
      .catch((error: Error) => ({ outcome: "rejected" as const, message: error.message }));
    console.log(`events.insert retry under the same id: ${JSON.stringify(retry)}`);
    if (retry.outcome === "resolved") expect(retry.eventId).toBe(created.eventId);
    else expect(retry.message).toMatch(/409|duplicate|already exists/i);
  });
});

describe("Google Drive + Docs", () => {
  const document = () => registry.get<DocumentAdapter>("document")!;
  // Drive refuses plus-addressed aliases (docs/live-tenant-testing.md), so
  // only a bare allowlisted address is offered a share.
  const collaborators = () => env.emails.filter((e) => !e.split("@")[0]!.includes("+")).slice(0, 1).map((email) => ({ email }));
  let docRef: string;

  it("files.get: probe the folder", async () => {
    await expect(document().probe()).resolves.toMatchObject({ anchoredDocEdits: true });
  });

  it("create, share and write the managed region, then re-render it", async () => {
    const first = await document().renderManagedRegion({
      docRef: null,
      title: `[contract run ${stamp}] doc`,
      markdown: "## Contract run\n- first render",
      collaborators: collaborators(),
      idempotencyKey: `contract:${stamp}:doc:1`,
    });
    docRef = first.docRef;
    expect(first.url).toContain(docRef);

    const second = await document().renderManagedRegion({
      docRef,
      title: `[contract run ${stamp}] doc`,
      markdown: "## Contract run\n- second render",
      collaborators: collaborators(),
      idempotencyKey: `contract:${stamp}:doc:2`,
    });
    expect(second.pinned).toBe(false);
  });

  it("revisions.list reports lastModifyingUser.me for our own write (isEchoRevision's premise)", async () => {
    const res = await transports.googleDocs("drive", `/files/${docRef}/revisions`, {
      method: "GET",
      query: { fields: "nextPageToken, revisions(lastModifyingUser(me))", pageSize: "1000" },
    });
    const revisions = res["revisions"] as { lastModifyingUser?: { me?: boolean } }[];
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions[revisions.length - 1]!.lastModifyingUser?.me).toBe(true);
  });
});

describe("Google Sheets", () => {
  const sheet = () => registry.get<SheetAdapter>("sheet")!;

  it("create in folder, add a tab, clear and overwrite it", async () => {
    await sheet().probe();
    const { spreadsheetId } = await sheet().ensureSpreadsheet({
      spreadsheetId: null,
      title: `[contract run ${stamp}] reports`,
      idempotencyKey: `contract:${stamp}:sheet`,
    });
    for (const [i, rows] of [[["a"], ["b"]], [["c"]]].entries()) {
      await sheet().writeTab({
        spreadsheetId,
        tabTitle: "Contract run",
        columns: ["value"],
        rows,
        idempotencyKey: `contract:${stamp}:tab:${i}`,
      });
    }
    const meta = await transports.googleSheets("sheets", `/spreadsheets/${spreadsheetId}`, {
      method: "GET",
      query: { fields: "sheets.properties(sheetId,title)" },
    });
    const titles = (meta["sheets"] as { properties: { title: string } }[]).map((s) => s.properties.title);
    expect(titles).toContain("Contract run");
  });
});
