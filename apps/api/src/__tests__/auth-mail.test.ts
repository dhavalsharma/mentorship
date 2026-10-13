import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAGIC_LINK_TTL_MINUTES, type MagicLinkStore } from "@mentorship/auth";
import type { EmailMessage, EmailSender } from "@mentorship/core";
import { FakeEmail, Recorder, SandboxRefusal } from "@mentorship/integrations";
import { FakeStaffDirectory } from "./staff-fake.js";
import { composeAuthEmail, createMagicLinkDelivery, magicLinkUrl, redactAddress } from "../auth-mail.js";
import { cooldownSecondsFromEnv, createCooldown } from "../mail-cooldown.js";
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

function harness(
  sender: EmailSender | null,
  overrides: { appBaseUrl?: string | null; cooldownSeconds?: number; now?: () => number; cooldownMaxEntries?: number } = {},
) {
  const logs: string[] = [];
  const unhandled: { reason: string; detail: Record<string, unknown> }[] = [];
  const deliver = createMagicLinkDelivery({
    sender,
    appBaseUrl: overrides.appBaseUrl === undefined ? BASE : overrides.appBaseUrl,
    onUnhandled: (reason, detail) => unhandled.push({ reason, detail }),
    log: (line) => logs.push(line),
    // Off unless a test is about the cooldown, so repeated sends stay independent.
    cooldownSeconds: overrides.cooldownSeconds ?? 0,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.cooldownMaxEntries !== undefined ? { cooldownMaxEntries: overrides.cooldownMaxEntries } : {}),
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

describe("createMagicLinkDelivery — per-address cooldown", () => {
  it("suppresses a second send inside the window, allows one after it (fake clock)", async () => {
    let t = 1_000_000;
    const fake = new FakeEmail(new Recorder());
    const { deliver, unhandled } = harness(fake, { cooldownSeconds: 60, now: () => t });

    deliver("ada@example.com", "tok-1");
    await settle();
    t += 59_000;
    deliver("ada@example.com", "tok-2");
    await settle();
    expect(fake.sent).toHaveLength(1);
    // Warned, without the address or either token.
    expect(unhandled.map((u) => u.reason)).toEqual(["magic_link_email_cooldown"]);
    expect(JSON.stringify(unhandled)).not.toMatch(/ada@|tok-/);

    t += 1_000;
    deliver("ada@example.com", "tok-3");
    await settle();
    expect(fake.sent).toHaveLength(2);
    expect(String((fake.sent[1]!.detail as unknown as EmailMessage).text)).toContain("tok-3");
  });

  it("normalises the address, and is per address and per kind", async () => {
    const fake = new FakeEmail(new Recorder());
    const { deliver } = harness(fake, { cooldownSeconds: 60, now: () => 1 });
    deliver("Ada@Example.com ", "t1");
    deliver("ada@example.com", "t2"); // same mailbox: suppressed
    deliver("grace@example.com", "t3"); // another address: sent
    deliver("ada@example.com", "t4", {
      kind: "invite",
      inviterName: "G",
      cohortName: "C",
      programName: "P",
      role: "mentee",
    }); // an invite is not swallowed by a sign-in flood
    await settle();
    expect(fake.sent).toHaveLength(3);
  });

  it("a failed send releases its slot: an immediate retry sends; a successful one stays suppressed", async () => {
    let t = 1_000_000;
    let failing = true;
    const sent: string[] = [];
    const sender: EmailSender = {
      id: "g",
      send: async (m) => {
        if (failing) throw new Error("gmail 503");
        sent.push(m.to);
        return { messageRef: "m1" };
      },
    };
    const { deliver, unhandled } = harness(sender, { cooldownSeconds: 60, now: () => t });
    deliver("ada@example.com", "tok-1");
    await settle();
    expect(unhandled.map((u) => u.reason)).toEqual(["magic_link_email_failed"]);

    failing = false;
    t += 1_000; // well inside the window
    deliver("ada@example.com", "tok-2");
    await settle();
    expect(sent).toHaveLength(1); // the retry was mailed

    t += 1_000;
    deliver("ada@example.com", "tok-3");
    await settle();
    expect(sent).toHaveLength(1); // success started the window: still suppressed
    expect(unhandled.map((u) => u.reason)).toEqual(["magic_link_email_failed", "magic_link_email_cooldown"]);
  });

  it("releases even when the failure reporter throws", async () => {
    let failing = true;
    const sent: string[] = [];
    const sender: EmailSender = {
      id: "g",
      send: async (m) => {
        if (failing) throw new Error("boom");
        sent.push(m.to);
        return { messageRef: "m" };
      },
    };
    const deliver = createMagicLinkDelivery({
      sender,
      appBaseUrl: BASE,
      cooldownSeconds: 60,
      now: () => 1,
      onUnhandled: () => {
        throw new Error("reporter down");
      },
    });
    deliver("ada@example.com", "a");
    await settle();
    failing = false;
    deliver("ada@example.com", "b");
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("release is a no-op for an unknown, expired or evicted key", () => {
    let t = 0;
    const c = createCooldown({ seconds: 60, maxEntries: 2, now: () => t });
    expect(() => c.release("never")).not.toThrow();
    c.allow("a");
    c.allow("b");
    c.allow("c"); // evicts a
    c.release("a");
    c.release("a");
    expect(c.size).toBe(2);
    c.release("b");
    expect(c.size).toBe(1);
    expect(c.allow("b")).toBe(true);
    t = 61_000;
    c.release("c"); // expired
    expect(c.allow("c")).toBe(true);
  });

  it("0 disables it", async () => {
    const fake = new FakeEmail(new Recorder());
    const { deliver } = harness(fake, { cooldownSeconds: 0 });
    deliver("ada@example.com", "a");
    deliver("ada@example.com", "b");
    await settle();
    expect(fake.sent).toHaveLength(2);
  });

  it("is bounded: the map never exceeds maxEntries, expired entries go first, then the oldest", () => {
    let t = 0;
    const c = createCooldown({ seconds: 60, maxEntries: 3, now: () => t });
    for (const k of ["a", "b", "c", "d", "e"]) {
      expect(c.allow(k)).toBe(true);
      expect(c.size).toBeLessThanOrEqual(3);
    }
    expect(c.size).toBe(3);
    expect(c.allow("e")).toBe(false); // still cooling
    expect(c.allow("a")).toBe(true); // evicted, so it may be mailed again early
    t = 61_000;
    expect(c.allow("z")).toBe(true);
    expect(c.size).toBe(1); // everything else had expired and was swept
  });

  it("parses MAGIC_LINK_EMAIL_COOLDOWN_SECONDS: default 60, 0 off, junk refused at boot", () => {
    expect(cooldownSecondsFromEnv({})).toBe(60);
    expect(cooldownSecondsFromEnv({ MAGIC_LINK_EMAIL_COOLDOWN_SECONDS: "0" })).toBe(0);
    expect(cooldownSecondsFromEnv({ MAGIC_LINK_EMAIL_COOLDOWN_SECONDS: "120" })).toBe(120);
    for (const bad of ["-1", "1.5", "abc", "999999"]) {
      expect(() => cooldownSecondsFromEnv({ MAGIC_LINK_EMAIL_COOLDOWN_SECONDS: bad })).toThrow(/COOLDOWN/);
    }
  });
});

describe("createMagicLinkDelivery — the reporting chain cannot lie or reject", () => {
  it("a throwing log does not report a sent mail as failed", async () => {
    const fake = new FakeEmail(new Recorder());
    const unhandled: string[] = [];
    const deliver = createMagicLinkDelivery({
      sender: fake,
      appBaseUrl: BASE,
      cooldownSeconds: 0,
      log: () => {
        throw new Error("log sink down");
      },
      onUnhandled: (reason) => unhandled.push(reason),
    });
    deliver("ada@example.com", TOKEN);
    await settle();
    expect(fake.sent).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("a throwing onUnhandled is swallowed: no unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const failing: EmailSender = {
        id: "g",
        send: async () => {
          throw new Error("quota");
        },
      };
      const deliver = createMagicLinkDelivery({
        sender: failing,
        appBaseUrl: BASE,
        cooldownSeconds: 0,
        onUnhandled: () => {
          throw new Error("reporter down");
        },
      });
      deliver("ada@example.com", TOKEN);
      await settle();
      await settle();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("addresses in failure reports", () => {
  it("a SandboxRefusal's message is scrubbed of the recipient, so no address reaches onUnhandled", async () => {
    const built = buildGmailSender(
      { GOOGLE_ACCESS_TOKEN: "x", GMAIL_SENDER_ADDRESS: "noreply@example.org", SANDBOX_ALLOWLIST: "me@example.org" },
      { transport: async () => ({ id: "m" }) },
    )!;
    const { deliver, unhandled } = harness(built.sender);
    deliver("Stranger@Example.net", TOKEN);
    await settle();
    expect(unhandled).toHaveLength(1);
    expect(JSON.stringify(unhandled)).not.toMatch(/stranger/i);
    expect(String(unhandled[0]!.detail["error"])).toContain("[address]");
  });

  it("redactAddress keeps the domain and drops the mailbox", () => {
    expect(redactAddress("ada.lovelace@example.net")).toBe("***@example.net");
    expect(redactAddress("junk")).toBe("[not-an-address]");
  });

  it("reports how many allowlist entries are active, for the startup line", () => {
    const env = { GOOGLE_ACCESS_TOKEN: "x", GMAIL_SENDER_ADDRESS: "n@example.org" };
    const opts = { transport: async () => ({ id: "m" }) };
    expect(buildGmailSender({ ...env, SANDBOX_ALLOWLIST: "a@x.org, b@x.org," }, opts)!.allowlistSize).toBe(2);
    expect(buildGmailSender(env, opts)!.allowlistSize).toBeNull();
  });
});

describe("the stated expiry", () => {
  it("is the one the magic-link store enforces, by construction", () => {
    const m = composeAuthEmail({ to: "a@example.com", link: "https://x/verify?token=t", context: { kind: "sign_in" } });
    expect(m.text).toContain(`expires in ${MAGIC_LINK_TTL_MINUTES} minutes`);
    expect(MAGIC_LINK_TTL_MINUTES).toBe(15);
  });

  it("an invite says what to do once it has expired", () => {
    const m = composeAuthEmail({
      to: "a@example.com",
      link: "https://x/verify?token=t",
      context: { kind: "invite", inviterName: "G", cohortName: "C", programName: "P", role: "mentee" },
    });
    expect(m.text).toMatch(/expired.*invite you again.*new sign-in link/);
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

  it("request-link is byte-identical: known + send ok, known + send fails, known + cooling down, known + seam throws, unknown", async () => {
    const failing: EmailSender = {
      id: "gmail",
      send: async () => {
        throw new Error("quota exceeded");
      },
    };
    const capture = async (deliver: Parameters<typeof listen>[0], email: string) => {
      const base = await listen(deliver);
      const res = await request(base, email);
      const out = { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
      close?.();
      close = undefined;
      return out;
    };

    const ok = harness(new FakeEmail(new Recorder()));
    const bad = harness(failing);
    const cooling = harness(new FakeEmail(new Recorder()), { cooldownSeconds: 60 });
    cooling.deliver("known@example.com", "earlier-token"); // opens the window
    const responses = {
      knownSendOk: await capture(ok.deliver, "known@example.com"),
      knownSendFails: await capture(bad.deliver, "known@example.com"),
      knownCoolingDown: await capture(cooling.deliver, "known@example.com"),
      knownSeamThrows: await capture(() => {
        throw new Error("seam blew up");
      }, "known@example.com"),
      unknown: await capture(ok.deliver, "nobody@example.com"),
    };
    await settle();

    for (const r of Object.values(responses)) expect(r).toEqual(responses.unknown);
    expect(responses.unknown.status).toBe(200);
    expect(responses.unknown.body).toBe(JSON.stringify({ requested: true }));
    // Operators, and only operators, can see the difference.
    expect(bad.unhandled.map((u) => u.reason)).toEqual(["magic_link_email_failed"]);
    expect(cooling.unhandled.map((u) => u.reason)).toEqual(["magic_link_email_cooldown"]);
    expect(ok.unhandled).toEqual([]);
  });

  it("hammering request-link for a known address mails once per window", async () => {
    const fake = new FakeEmail(new Recorder());
    const { deliver } = harness(fake, { cooldownSeconds: 60 });
    const base = await listen(deliver);
    const bodies = new Set<string>();
    for (let i = 0; i < 20; i++) bodies.add(await (await request(base, "known@example.com")).text());
    await settle();
    expect(fake.sent).toHaveLength(1);
    expect(bodies.size).toBe(1);
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
