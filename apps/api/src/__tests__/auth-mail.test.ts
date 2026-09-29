import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MagicLinkStore } from "@mentorship/auth";
import type { EmailMessage, EmailSender } from "@mentorship/core";
import { FakeEmail, Recorder, SandboxRefusal } from "@mentorship/integrations";
import { FakeStaffDirectory } from "./staff-fake.js";
import { composeAuthEmail, createMagicLinkDelivery, magicLinkUrl } from "../auth-mail.js";
import { appBaseUrlFromEnv, buildGmailSender } from "../email-config.js";
import { createServer, type ApiServerDeps, type EnrollmentService } from "../server.js";

/**
 * Sign-in and invite mail: the delivery seam, the config that builds it, and
 * the two properties that must survive it over a real socket — an identical
 * `/auth/request-link` response whatever the send does, and a printed link
 * only when no sender is configured. The Gmail wire format is
 * `google-gmail.test.ts`; nothing here touches a network.
 */

const BASE = "https://app.example.org";
const TOKEN = "tok_SECRET-abc123";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function harness(sender: EmailSender | null, overrides: { appBaseUrl?: string | null } = {}) {
  const logs: string[] = [];
  const unhandled: { reason: string; detail: Record<string, unknown> }[] = [];
  const deliver = createMagicLinkDelivery({
    sender,
    appBaseUrl: overrides.appBaseUrl === undefined ? BASE : overrides.appBaseUrl,
    onUnhandled: (reason, detail) => unhandled.push({ reason, detail }),
    log: (line) => logs.push(line),
  });
  return { deliver, logs, unhandled };
}

describe("createMagicLinkDelivery — no sender configured", () => {
  it("prints exactly the line apps/web/e2e reads, and nothing else", () => {
    const { deliver, logs } = harness(null, { appBaseUrl: null });
    deliver("ada@example.com", TOKEN);
    expect(logs).toEqual([`[auth] magic link for ada@example.com: ${TOKEN}`]);
  });
});

describe("createMagicLinkDelivery — sender configured", () => {
  it("emails a sign-in link and never prints the token, the link or the address", async () => {
    const recorder = new Recorder();
    const fake = new FakeEmail(recorder);
    const { deliver, logs, unhandled } = harness(fake);

    deliver("ada@example.com", TOKEN);
    await settle();

    expect(fake.sent).toHaveLength(1);
    const detail = fake.sent[0]!.detail as unknown as EmailMessage;
    expect(detail.to).toBe("ada@example.com");
    expect(detail.subject).toBe("Your Mentorship sign-in link");
    expect(detail.text).toContain(`${BASE}/verify?token=${encodeURIComponent(TOKEN)}`);
    expect(detail.html).toContain("Sign in");
    expect(unhandled).toEqual([]);
    const printed = logs.join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain("verify?token");
    expect(printed).not.toContain("ada@example.com");
    expect(printed).toMatch(/sign_in email sent/);
  });

  it("words an invite with who invited them, which cohort and program, and the role", async () => {
    const fake = new FakeEmail(new Recorder());
    const { deliver } = harness(fake);
    deliver("ada@example.com", TOKEN, {
      kind: "invite",
      inviterName: "Grace Hopper",
      cohortName: "Autumn 2026",
      programName: "Engineering Mentoring",
      role: "mentee",
    });
    await settle();
    const sent = fake.sent[0]!.detail as unknown as EmailMessage;
    expect(sent.subject).toBe("Grace Hopper invited you to Autumn 2026 on Mentorship");
    expect(sent.text).toContain("Grace Hopper invited you to join Autumn 2026 (Engineering Mentoring) as mentee.");
    expect(sent.text).toContain(`${BASE}/verify?token=`);
  });

  it("returns before the send settles — a slow vendor cannot slow the route", () => {
    let release!: () => void;
    const slow: EmailSender = {
      id: "slow",
      send: () => new Promise((resolve) => (release = () => resolve({ messageRef: "m" }))),
    };
    const { deliver } = harness(slow);
    expect(deliver("ada@example.com", TOKEN)).toBeUndefined();
    release?.();
  });

  it("reports a rejected send to onUnhandled, with the token scrubbed from the reason", async () => {
    const failing: EmailSender = {
      id: "gmail",
      send: async () => {
        throw new Error(`google gmail failed: bad request echoing ${TOKEN} and ${encodeURIComponent(TOKEN)}`);
      },
    };
    const { deliver, unhandled, logs } = harness(failing);
    deliver("ada@example.com", TOKEN);
    await settle();
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]!.reason).toBe("magic_link_email_failed");
    expect(JSON.stringify(unhandled)).not.toContain(TOKEN);
    expect(String(unhandled[0]!.detail["error"])).toContain("[token]");
    expect(logs.join("")).not.toContain(TOKEN);
  });

  it("survives a sender that throws synchronously", async () => {
    const throwing: EmailSender = {
      id: "x",
      send: () => {
        throw new Error("boom");
      },
    };
    const { deliver, unhandled } = harness(throwing);
    expect(() => deliver("ada@example.com", TOKEN)).not.toThrow();
    await settle();
    expect(unhandled).toHaveLength(1);
  });

  it("refuses to be built with a sender and no base URL", () => {
    expect(() => harness(new FakeEmail(new Recorder()), { appBaseUrl: null })).toThrow(/appBaseUrl/);
  });
});

describe("composeAuthEmail", () => {
  const link = "https://app.example.org/verify?token=t";

  it("HTML-escapes a hostile inviter name and never lets it break the html", () => {
    const m = composeAuthEmail({
      to: "a@example.com",
      link,
      context: {
        kind: "invite",
        inviterName: '<img src=x onerror="alert(1)">',
        cohortName: "C",
        programName: "P",
        role: "mentor",
      },
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img");
  });

  it("collapses a line break in an admin-typed name instead of failing the invite", async () => {
    const fake = new FakeEmail(new Recorder());
    const { deliver, unhandled } = harness(fake);
    deliver("ada@example.com", TOKEN, {
      kind: "invite",
      inviterName: "Grace\r\nBcc: victim@example.com",
      cohortName: "C",
      programName: "P",
      role: "mentee",
    });
    await settle();
    expect(unhandled).toEqual([]);
    expect((fake.sent[0]!.detail as unknown as EmailMessage).subject).not.toMatch(/[\r\n]/);
  });

  it("builds the link from the base URL with the token URL-encoded", () => {
    expect(magicLinkUrl("https://app.example.org/", "a+b/c")).toBe("https://app.example.org/verify?token=a%2Bb%2Fc");
  });
});

describe("buildGmailSender / appBaseUrlFromEnv", () => {
  const creds = { GOOGLE_ACCESS_TOKEN: "ya29.static" };

  it("is null with no GMAIL_SENDER_ADDRESS — the print fallback", () => {
    expect(buildGmailSender({})).toBeNull();
    expect(buildGmailSender({ GMAIL_SENDER_ADDRESS: "  " })).toBeNull();
  });

  it("throws at boot when the sender is set but credentials are not", () => {
    expect(() => buildGmailSender({ GMAIL_SENDER_ADDRESS: "noreply@example.org" })).toThrow(/Google credentials/);
  });

  it("sends through the transport as the configured sender", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const built = buildGmailSender(
      { ...creds, GMAIL_SENDER_ADDRESS: "noreply@example.org", GMAIL_SENDER_NAME: "Mentorship", GMAIL_REPLY_TO: "help@example.org" },
      { transport: async (path, init) => (calls.push({ path, body: init.body }), { id: "m1" }) },
    )!;
    await built.sender.send({ to: "ada@example.com", subject: "s", text: "t", idempotencyKey: "k" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/users/me/messages/send");
    const raw = Buffer.from((calls[0]!.body as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toContain('From: "Mentorship" <noreply@example.org>');
    expect(raw).toContain("Reply-To: help@example.org");
  });

  it("with SANDBOX_ALLOWLIST set, refuses any other recipient before the transport", async () => {
    const calls: unknown[] = [];
    const refused: string[] = [];
    const built = buildGmailSender(
      { ...creds, GMAIL_SENDER_ADDRESS: "noreply@example.org", SANDBOX_ALLOWLIST: "me@example.org, U0ABC12345" },
      { transport: async (...args) => (calls.push(args), { id: "m" }), onRefused: (d) => refused.push(...d.refused) },
    )!;
    await expect(
      built.sender.send({ to: "stranger@example.net", subject: "s", text: "t", idempotencyKey: "a" }),
    ).rejects.toBeInstanceOf(SandboxRefusal);
    expect(calls).toHaveLength(0);
    expect(refused).toEqual(["stranger@example.net"]);
    await built.sender.send({ to: "ME@example.org", subject: "s", text: "t", idempotencyKey: "b" });
    expect(calls).toHaveLength(1);
  });

  it("without SANDBOX_ALLOWLIST there is no guard (production)", async () => {
    const built = buildGmailSender(
      { ...creds, GMAIL_SENDER_ADDRESS: "noreply@example.org" },
      { transport: async () => ({ id: "m" }) },
    )!;
    await expect(
      built.sender.send({ to: "anyone@example.net", subject: "s", text: "t", idempotencyKey: "a" }),
    ).resolves.toEqual({ messageRef: "m" });
  });

  it("requires https for APP_BASE_URL, except on localhost", () => {
    expect(appBaseUrlFromEnv({})).toBeNull();
    expect(appBaseUrlFromEnv({ APP_BASE_URL: "https://app.example.org/" })).toBe("https://app.example.org");
    expect(appBaseUrlFromEnv({ APP_BASE_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(() => appBaseUrlFromEnv({ APP_BASE_URL: "http://app.example.org" })).toThrow(/https/);
    expect(() => appBaseUrlFromEnv({ APP_BASE_URL: "not a url" })).toThrow(/not a URL/);
  });
});

// ---------------------------------------------------------------------------
// Over a real socket
// ---------------------------------------------------------------------------

const ORG = "11111111-1111-1111-1111-111111111111";
const COHORT = "33333333-3333-3333-3333-333333333333";

class Store implements MagicLinkStore {
  users = new Map<string, string>();
  sessions = new Map<string, string>();
  async findUserByEmail(_o: string, email: string) {
    const userId = this.users.get(email);
    return userId ? { userId } : null;
  }
  async createLink() {}
  async findUnconsumedLinkByTokenHash() {
    return null;
  }
  async consumeLink() {
    return false;
  }
  async createSession() {
    return { sessionId: "s" };
  }
  async findActiveSession(_o: string, sessionId: string) {
    const userId = this.sessions.get(sessionId);
    return userId
      ? { userId, expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null }
      : null;
  }
}

describe("over a real socket", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(deliver: NonNullable<NonNullable<ApiServerDeps["auth"]>["onMagicLinkIssued"]>) {
    const store = new Store();
    store.users.set("known@example.com", "user-1");
    store.sessions.set("admin-session", "admin-1");
    const enrollment: EnrollmentService = {
      invite: async (_org, plan) => {
        store.users.set(plan.email, "invitee");
        return {
          ok: true,
          participantId: "p-1",
          alreadyInvited: false,
          state: "invited",
          invitation: { inviterName: "Grace Hopper", cohortName: "Autumn 2026", programName: "Eng Mentoring" },
        };
      },
      acceptPendingInvites: async () => ({ accepted: [] }),
    };
    const server = createServer({
      slackSigningSecret: "s",
      identity: { resolveParticipantId: async () => null },
      responder: { respond: async () => {} },
      auth: { store, staff: new FakeStaffDirectory("admin"), orgId: ORG, onMagicLinkIssued: deliver },
      enrollment,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const request = (base: string, email: string) =>
    fetch(`${base}/auth/request-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

  it("request-link is byte-identical for a known email, an unknown one, and a known one whose send fails", async () => {
    const failing: EmailSender = {
      id: "gmail",
      send: async () => {
        throw new Error("quota exceeded");
      },
    };
    const { deliver, unhandled } = harness(failing);
    const base = await listen(deliver);

    const responses = await Promise.all(
      ["known@example.com", "nobody@example.com"].map(async (email) => {
        const res = await request(base, email);
        return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
      }),
    );
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]!.body).toBe(JSON.stringify({ requested: true }));

    await settle();
    // The failure is visible to operators, and only to them.
    expect(unhandled.map((u) => u.reason)).toEqual(["magic_link_email_failed"]);
  });

  it("request-link stays 200 and identical even if the delivery seam itself throws", async () => {
    const base = await listen(() => {
      throw new Error("seam blew up");
    });
    const known = await request(base, "known@example.com");
    const unknown = await request(base, "nobody@example.com");
    expect(known.status).toBe(200);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("an invite mails the invite wording with inviter, cohort, program and role", async () => {
    const fake = new FakeEmail(new Recorder());
    const { deliver } = harness(fake);
    const base = await listen(deliver);

    const res = await fetch(`${base}/orgs/${ORG}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "mentorship_session=admin-session" },
      body: JSON.stringify({ email: "ada@example.com", cohortId: COHORT, role: "mentee" }),
    });
    expect(res.status).toBe(201);
    const body = await res.text();
    await settle();

    expect(fake.sent).toHaveLength(1);
    const sent = fake.sent[0]!.detail as unknown as EmailMessage;
    expect(sent.to).toBe("ada@example.com");
    expect(sent.subject).toBe("Grace Hopper invited you to Autumn 2026 on Mentorship");
    expect(sent.text).toContain("as mentee");
    // The admin's response still never carries the link.
    expect(body).not.toContain("verify?token");
  });
});
