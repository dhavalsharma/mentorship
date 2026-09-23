import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { asc, eq } from "drizzle-orm";
import {
  defaultPolicy,
  type Interval,
  type LlmProvider,
  type ProgramPolicy,
} from "@mentorship/core";
import { createClient, events, schema, organizations, type Db } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  FakeCalendar,
  FakeConversation,
  FakeDm,
  FakeDocument,
  FakeTranscript,
  IntegrationRegistry,
  type Recorded,
} from "@mentorship/integrations";
import { commitMatchingRound, type MatchingOutput } from "@mentorship/primitive-matching";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import type { TraceLine } from "@mentorship/workflows";
import { buildPostgresApiDeps } from "../../../apps/api/src/postgres-deps.js";
import { createServer } from "../../../apps/api/src/server.js";
import { createWorker, type Worker } from "../../../apps/worker/src/worker.js";
import {
  ClockedRecorder,
  CrashSwitch,
  DownDm,
  instrument,
  recordingSlackTransport,
} from "./adapters.js";
import { JourneyClock } from "./clock.js";
import { seededUuids } from "./ids.js";
import {
  bindProbedCapabilities,
  PostgresRosterSink,
  seedOrg,
  type ConsentSeed,
} from "./seed.js";

/**
 * The journey stage: one org, seeded through the real import path, then two
 * processes — `apps/api` listening on a real socket and `apps/worker` draining
 * the outbox — sharing nothing but Postgres. Each gets its own connection
 * pool, as two processes would.
 *
 * The rule the whole suite rests on (docs/e2e-testing-strategy.md, Tier 2):
 * after `stage()` returns, a journey acts only through the two doors a human
 * has — a signed HTTP request, and the passage of time — and observes only
 * through the surfaces an operator has: the event log, the adapter recorder,
 * and the process logs. Nothing on `Stage` reaches a repository, a saga, or
 * `saga_instances.state`. The two exceptions are the properties in
 * `properties.ts`, each of which says why it needs what it reads.
 */

export const SIGNING_SECRET = "e2e-signing-secret";
/**
 * The worker and the API both run as the unprivileged tenant role, the way
 * production is meant to (`TENANT_ROLE`). Locally the connection is a
 * superuser and RLS would otherwise be bypassed; this makes every journey a
 * tenancy test too.
 */
export const TENANT_ROLE = "mentorship_app";
/** A Monday, 11:30 in India — the proposer has working hours to offer. */
export const DEFAULT_START = "2026-09-14T06:00:00.000Z";

export const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun@example.com,Arjun Rao,priya@example.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

export interface Party {
  slackUserId: string;
  name: string;
  email: string;
}

export interface StageOptions {
  orgId?: string;
  startAt?: string;
  /** Program policy overrides, merged over the journey defaults below. */
  policy?: Parameters<typeof defaultPolicy>[0];
  /** A roster CSV — seeded through `planRosterImport`/`commitRosterImport`. */
  roster?: string;
  /**
   * `matching` seeds the same people through the roster sink but creates the
   * pairings through `commitMatchingRound` — ADR-0003 says nothing downstream
   * can tell the difference, and `import-vs-match` holds it to that.
   */
  seedVia?: "roster" | "matching";
  consents?: ConsentSeed;
  busy?: Record<string, Interval[]>;
  adapters?: {
    /** Absent: the tenant has no transcription at all. */
    transcript?: { autoTranscription?: "native" | "byo" | "none"; availableAfterFetches?: number; text?: string };
    /** Default true. */
    document?: boolean;
    /** `down`: bound and probed, and every send throws. */
    dm?: "up" | "down";
  };
  llm?: LlmProvider;
  onTrace?: (line: TraceLine) => void;
}

export interface DrainResult {
  passes: number;
  delivered: number;
  timers: number;
  failed: number;
  deadLettered: number;
  errors: string[];
}

export interface StageEvent {
  name: string;
  subjectRef: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  relayed: boolean;
  deadLettered: boolean;
}

export interface Stage {
  readonly orgId: string;
  readonly clock: JourneyClock;
  /** The pairings the seed created, in roster order. */
  readonly pairingIds: string[];
  /** Everyone the roster named, by Slack id. */
  readonly people: Map<string, Party>;
  /** The first row's mentor and mentee. */
  readonly mentor: Party;
  readonly mentee: Party;

  advanceTo(iso: string): void;
  advanceBy(by: { days?: number; hours?: number; minutes?: number }): void;
  /**
   * `worker.pass()` until a pass delivers nothing and fires no timer. Throws
   * on a failed delivery or a pass that threw, unless `tolerate` — a journey
   * that means to watch a failure says so.
   */
  drain(options?: { tolerate?: boolean }): Promise<DrainResult>;

  /** A genuinely signed block_actions POST to the listening socket. */
  click(
    who: Party,
    action: { action_id: string; value: Record<string, unknown> },
    extra?: { trigger_id?: string },
  ): Promise<Response>;
  submitModal(who: Party, view: Record<string, unknown>): Promise<Response>;
  /** A genuinely signed Events API `message` — a participant typing in the thread. */
  say(who: Party, text: string, options?: { channel?: string; ts?: string }): Promise<Response>;

  // The three surfaces, and the only ones.
  events(): Promise<StageEvent[]>;
  calls(): Recorded[];
  /** Operator logs: worker warnings and API "acked but did nothing" notes. */
  logs(): string[];

  /** Raw fakes, for acting as the vendor would (a human editing the doc). */
  readonly vendor: { document: FakeDocument | null; calendar: FakeCalendar };
  /** Test-harness internals for the properties. Never used by a journey. */
  readonly internals: StageInternals;
  close(): Promise<void>;
}

export interface StageInternals {
  observer: TestDb;
  crash: CrashSwitch;
  /** Replace the worker as a restarted process would: fresh pool, fresh caches. */
  restartWorker(): Promise<void>;
  worker(): Worker;
}

const DEFAULT_POLICY: Parameters<typeof defaultPolicy>[0] = {
  pairing: { mode: "imported" },
  cadence: { everyDays: 14, label: "fortnightly", reminderLeadHours: 24 },
  consent: { aiProcessing: "optional", recording: "opt_in" },
};

export async function stage(options: StageOptions = {}): Promise<Stage> {
  if (!DATABASE_URL) {
    throw new Error("the journey suite needs DATABASE_URL — it is Postgres or nothing");
  }
  const orgId = options.orgId ?? randomUUID();
  const clock = new JourneyClock(options.startAt ?? DEFAULT_START);
  const now = clock.now;
  const ids = seededUuids(orgId);
  // Stamped with `peek`, not `now`: observing must not move the clock.
  const recorder = new ClockedRecorder(() => clock.peek());
  const crash = new CrashSwitch();
  const logs: string[] = [];

  const policy: ProgramPolicy = defaultPolicy({
    ...DEFAULT_POLICY,
    ...(options.policy ?? {}),
  });

  // --- the outside world: Slack and Google, as fakes that outlive a restart
  const conversation = new FakeConversation(recorder);
  const calendar = new FakeCalendar(recorder, options.busy ?? {});
  const document = options.adapters?.document === false ? null : new FakeDocument(recorder);
  const dm = options.adapters?.dm === "down" ? new DownDm(recorder) : new FakeDm(recorder);
  const transcript = options.adapters?.transcript
    ? new FakeTranscript(recorder, options.adapters.transcript)
    : null;

  const registry = new IntegrationRegistry();
  registry.bind(instrument(conversation, crash));
  registry.bind(instrument(dm, crash));
  registry.bind(instrument(calendar, crash));
  if (document) registry.bind(instrument(document, crash));
  if (transcript) registry.bind(instrument(transcript, crash));

  // --- seed: the only direct writes a journey gets
  const observer = await connectTestDb();
  const org = await seedOrg(observer.db, { orgId, policy, at: clock.peek() });
  await bindProbedCapabilities(observer.db, orgId, registry, clock.peek());

  const sink = new PostgresRosterSink(observer.db, org, {
    now,
    ...(options.consents ? { consents: options.consents } : {}),
  });
  const plan = planRosterImport(options.roster ?? ONE_PAIR, {
    policy,
    defaultTzOffsetMinutes: 0,
  });
  if (plan.errors.length > 0) {
    throw new Error(`roster does not plan: ${JSON.stringify(plan.errors)}`);
  }

  const people = new Map<string, Party>();
  for (const pair of plan.creates) {
    for (const person of [pair.mentor, pair.mentee]) {
      if (person.chatRef) {
        people.set(person.chatRef, {
          slackUserId: person.chatRef,
          name: person.displayName,
          email: person.email,
        });
      }
    }
  }

  let pairingIds: string[];
  if (options.seedVia === "matching") {
    // Enrol the same people through the same sink, then let the matching
    // commit create the pairs. The assignment is what an approved round
    // would carry; the solver's choice is not what this journey is about.
    const assignments = [];
    for (const pair of plan.creates) {
      const mentor = await sink.upsertPerson(pair.mentor);
      const mentee = await sink.upsertPerson(pair.mentee);
      assignments.push({ mentorId: mentor.participantId, menteeId: mentee.participantId });
    }
    const output: MatchingOutput = {
      cohortId: org.cohortId,
      orgId,
      asOf: clock.peek().toISOString(),
      solver: "journey-seed",
      adjudicated: false,
      adjudicationErrors: 0,
      assignments: assignments.map((a, i) => ({
        ...a,
        score: 1,
        deterministicScore: 1,
        rank: i + 1,
        rationale: null,
        riskFlags: [],
      })),
      unmatched: [],
      mentorLoad: [],
      candidates: [],
    };
    const committed = await commitMatchingRound(output, sink, { pairsStart: "active" });
    pairingIds = committed.created.map((c) => c.pairingId);
  } else {
    const committed = await commitRosterImport(plan, sink, { importedPairsStart: "active" });
    pairingIds = committed.created.map((c) => c.pairingId);
  }

  // --- process 1: apps/api, with the wiring main.ts ships
  const apiClient = createClient(DATABASE_URL);
  const server: Server = createServer(
    buildPostgresApiDeps({
      db: apiClient.db,
      orgId,
      slackSigningSecret: SIGNING_SECRET,
      role: TENANT_ROLE,
      slackTransport: recordingSlackTransport(recorder),
      now,
      onUnhandled: (reason, detail) => logs.push(`api: ${reason} ${JSON.stringify(detail)}`),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // --- process 2: apps/worker
  let workerClient = createClient(DATABASE_URL);
  const buildWorker = (db: Db): Worker =>
    createWorker({
      db,
      orgId,
      registry,
      role: TENANT_ROLE,
      ids,
      now,
      ...(options.llm ? { llm: options.llm } : {}),
      ...(options.onTrace ? { onTrace: options.onTrace } : {}),
      onWarn: (message, detail) =>
        logs.push(`worker: ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
    });
  let worker = buildWorker(workerClient.db);

  const restartWorker = async (): Promise<void> => {
    // `timeout: 0` drops the sockets: whatever transaction the dead process
    // held is rolled back by Postgres, and its row locks go with it.
    await workerClient.sqlClient.end({ timeout: 0 });
    workerClient = createClient(DATABASE_URL!);
    worker = buildWorker(workerClient.db);
  };

  const onePass = async (): Promise<Awaited<ReturnType<Worker["pass"]>> | "crashed"> => {
    const pass = worker.pass();
    if (crash.hasFired) return pass;
    const crashed = crash.whenFired().then(() => "crashed" as const);
    // A pass abandoned mid-crash never settles; keep its rejection (from the
    // pool being ended under it) from surfacing as unhandled.
    pass.catch(() => {});
    return Promise.race([pass, crashed]);
  };

  const drain = async (drainOptions: { tolerate?: boolean } = {}): Promise<DrainResult> => {
    const total: DrainResult = {
      passes: 0,
      delivered: 0,
      timers: 0,
      failed: 0,
      deadLettered: 0,
      errors: [],
    };
    for (;;) {
      if (total.passes >= 200) throw new Error("drain did not converge in 200 passes");
      total.passes += 1;
      let result: Awaited<ReturnType<typeof onePass>>;
      try {
        result = await onePass();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        total.errors.push(message);
        logs.push(`worker: pass threw ${message}`);
        break;
      }
      if (result === "crashed") {
        await restartWorker();
        continue;
      }
      total.delivered += result.relay.delivered;
      total.timers += result.timers;
      total.failed += result.relay.failed;
      total.deadLettered += result.relay.deadLettered;
      if (result.relay.delivered === 0 && result.timers === 0) break;
    }
    if (!drainOptions.tolerate && (total.errors.length > 0 || total.failed > 0 || total.deadLettered > 0)) {
      throw new Error(
        `drain hit failures: ${JSON.stringify({ ...total, logs: logs.slice(-5) })}`,
      );
    }
    return total;
  };

  // --- the two human doors
  let triggerSeq = 0;
  let tsSeq = 0;

  const signed = async (path: string, body: string, contentType: string): Promise<Response> => {
    const timestamp = String(Math.floor(clock.peek().getTime() / 1000));
    const signature =
      "v0=" +
      createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
  };

  const form = (payload: unknown): string =>
    `payload=${encodeURIComponent(JSON.stringify(payload))}`;

  const click: Stage["click"] = (who, action, extra = {}) =>
    signed(
      "/slack/interactions",
      form({
        type: "block_actions",
        user: { id: who.slackUserId },
        trigger_id: extra.trigger_id ?? `trg-${orgId.slice(0, 8)}-${++triggerSeq}`,
        actions: [{ action_id: action.action_id, value: JSON.stringify(action.value) }],
      }),
      "application/x-www-form-urlencoded",
    );

  const submitModal: Stage["submitModal"] = (who, view) =>
    signed(
      "/slack/interactions",
      form({ type: "view_submission", user: { id: who.slackUserId }, view }),
      "application/x-www-form-urlencoded",
    );

  const readEvents = async (): Promise<StageEvent[]> => {
    const rows = await observer.db
      .select()
      .from(events)
      .where(eq(events.orgId, orgId))
      .orderBy(asc(events.occurredAt));
    return rows.map((r) => ({
      name: r.name,
      subjectRef: r.subjectRef,
      payload: r.payload as Record<string, unknown>,
      occurredAt: r.occurredAt.toISOString(),
      relayed: r.relayedAt !== null,
      deadLettered: r.deadLetteredAt !== null,
    }));
  };

  const say: Stage["say"] = async (who, text, sayOptions = {}) => {
    let channel = sayOptions.channel;
    if (!channel) {
      // The pair's thread as the system announced it — the same channel id a
      // participant would be typing into.
      const bound = (await readEvents()).filter(
        (e) => e.name === "pair.thread_bound" && e.subjectRef === `pairing:${pairingIds[0]}`,
      );
      channel = String(bound.at(-1)?.payload["channelId"] ?? "");
      if (!channel) throw new Error("say(): no thread has been bound for the first pair yet");
    }
    const ts =
      sayOptions.ts ?? `${Math.floor(clock.peek().getTime() / 1000)}.${String(++tsSeq).padStart(6, "0")}`;
    return signed(
      "/slack/events",
      JSON.stringify({
        type: "event_callback",
        event: { type: "message", channel, user: who.slackUserId, ts, text },
      }),
      "application/json",
    );
  };

  const firstPair = plan.creates[0];
  const party = (chatRef: string | null): Party => {
    const found = chatRef ? people.get(chatRef) : undefined;
    if (!found) throw new Error("the first roster row needs Slack ids for both parties");
    return found;
  };

  return {
    orgId,
    clock,
    pairingIds,
    people,
    mentor: party(firstPair?.mentor.chatRef ?? null),
    mentee: party(firstPair?.mentee.chatRef ?? null),
    advanceTo: (iso) => clock.advanceTo(iso),
    advanceBy: (by) => clock.advanceBy(by),
    drain,
    click,
    submitModal,
    say,
    events: readEvents,
    calls: () => recorder.calls,
    logs: () => logs,
    vendor: { document, calendar },
    internals: { observer, crash, restartWorker, worker: () => worker },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await apiClient.sqlClient.end({ timeout: 5 });
      await workerClient.sqlClient.end({ timeout: 5 });
      // Only this org's rows, and only after the journey is done with them —
      // never a truncate: other suites share this database.
      for (const table of Object.values(schema)) {
        if (table === organizations) continue;
        if ("orgId" in table) {
          await observer.db.delete(table).where(eq(table.orgId, orgId));
        }
      }
      await observer.db.delete(organizations).where(eq(organizations.id, orgId));
      await observer.close();
    },
  };
}
