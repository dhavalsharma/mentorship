import {
  applyPairPreferences,
  recordResponse,
  resolveCadence,
  sequentialIds,
  subjectRef,
  type Agreement,
  type AgreementResponse,
  type Cadence,
  type CalendarAdapter,
  type IdFactory,
  type Interval,
  type PairContext,
  type PairParticipant,
  type PairPreferences,
  type PairingOrigin,
  type PairingState,
  type ProposalOption,
  type ProgramPolicy,
  type ResponseKind,
  type SagaResolvers,
  type SlotName,
} from "@mentorship/core";
import type { EventLog } from "@mentorship/events";
import type { IntegrationRegistry } from "@mentorship/integrations";
import type { PlannedPerson, RosterSink } from "@mentorship/roster";

/**
 * An in-memory stand-in for `packages/db` + `packages/api`.
 *
 * It exists so the whole saga, the integration layer and the roster importer
 * can be exercised — by the test suite and by `pnpm demo` — without a database.
 * Every method here has a direct Postgres equivalent in packages/db/schema.ts;
 * the read methods become queries inside `withTenant`, and the event handlers
 * become outbox-relay subscribers.
 */

export class Clock {
  private t: number;
  constructor(start: string) {
    this.t = Date.parse(start);
  }
  now = (): Date => new Date(this.t);
  iso = (): string => new Date(this.t).toISOString();
  advanceTo(at: string): void {
    const next = Date.parse(at);
    if (next > this.t) this.t = next;
  }
  advanceBy(ms: number): void {
    this.t += ms;
  }
}

interface StoredUser {
  userId: string;
  email: string;
  displayName: string;
  tzOffsetMinutes: number;
  chatRef: string | null;
}

interface StoredParticipant {
  participantId: string;
  userId: string;
  role: string;
  consent: { aiProcessing: boolean; recording: boolean };
}

interface StoredPairing {
  pairingId: string;
  pairKey: string;
  mentorParticipantId: string;
  menteeParticipantId: string;
  state: PairingState;
  origin: PairingOrigin;
  cadenceOverride: Record<string, unknown> | null;
  lastSessionAt: string | null;
  documentRef: string | null;
  /** The `pairings.thread_ref` column, narrowed to the part anything reads. */
  threadChannelId: string | null;
  notes: string | null;
}

interface StoredSession {
  sessionId: string;
  pairingId: string;
  startsAt: string;
  endsAt: string;
  calendarEventId: string;
  transcriptionEnabled: boolean;
  state: string;
}

export class World implements SagaResolvers, RosterSink {
  readonly users = new Map<string, StoredUser>();
  readonly participants = new Map<string, StoredParticipant>();
  readonly pairings = new Map<string, StoredPairing>();
  readonly agreements = new Map<string, Agreement>();
  readonly sessions = new Map<string, StoredSession>();
  readonly feedback: { sessionId: string; participantId: string; score: number }[] =
    [];
  /**
   * The org's guideline doc link, org-wide rather than per-pairing, mirroring
   * the single `integration_bindings` row Postgres reads it from. Writable so a
   * test can opt into the configured path; unconfigured is the default.
   */
  playbookUrl: string | null = null;
  private readonly extractionPairings = new Map<string, string>();
  private readonly submittedNoteIds = new Set<string>();
  private readonly ids: IdFactory;

  constructor(
    readonly orgId: string,
    readonly policy: ProgramPolicy,
    private readonly log: EventLog,
    private readonly registry: IntegrationRegistry,
    private readonly clock: Clock,
    /** Recording consent is off by default and needs every party. */
    private readonly defaultConsent = { aiProcessing: true, recording: false },
    ids?: IdFactory,
  ) {
    this.ids = ids ?? sequentialIds();
    this.log.on((event) => this.project(event));
  }

  // -------------------------------------------------------------------------
  // SagaResolvers — read-only, deterministic
  // -------------------------------------------------------------------------

  async pairContext(pairingId: string): Promise<PairContext> {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new Error(`unknown pairing ${pairingId}`);

    const participants = [
      pairing.mentorParticipantId,
      pairing.menteeParticipantId,
    ].map((id): PairParticipant => {
      const participant = this.participants.get(id);
      if (!participant) throw new Error(`unknown participant ${id}`);
      const user = [...this.users.values()].find(
        (u) => u.userId === participant.userId,
      );
      if (!user) throw new Error(`unknown user for participant ${id}`);
      return {
        participantId: participant.participantId,
        role: participant.role,
        displayName: user.displayName,
        email: user.email,
        memberRef: user.chatRef ?? `email:${user.email}`,
        calendarRef: user.email,
        tzOffsetMinutes: user.tzOffsetMinutes,
        consent: participant.consent,
      };
    });

    const names = participants.map((p) => p.displayName).join(" & ");

    return {
      pairingId,
      orgId: this.orgId,
      title: `Mentoring — ${names}`,
      state: pairing.state,
      origin: pairing.origin,
      policy: this.policy,
      cadence: resolveCadence(this.policy.cadence, null, pairing.cadenceOverride),
      participants,
      lastSessionAt: pairing.lastSessionAt,
      documentRef: pairing.documentRef,
      playbookUrl: this.playbookUrl,
    };
  }

  async freeBusy(input: {
    calendarRefs: string[];
    window: Interval;
  }): Promise<Record<string, Interval[]>> {
    const calendar = this.registry.get<CalendarAdapter>("calendar");
    if (!calendar) return {};
    return calendar.freeBusy({
      memberRefs: input.calendarRefs,
      window: input.window,
    });
  }

  async agreement(agreementId: string): Promise<Agreement | null> {
    return this.agreements.get(agreementId) ?? null;
  }

  async capabilities(slot: SlotName) {
    return this.registry.capabilities(slot);
  }

  // -------------------------------------------------------------------------
  // RosterSink — the optional-pairing path
  // -------------------------------------------------------------------------

  async upsertPerson(person: PlannedPerson): Promise<{ participantId: string }> {
    let user = this.users.get(person.email);
    if (!user) {
      user = {
        userId: this.ids.next("usr"),
        email: person.email,
        displayName: person.displayName,
        tzOffsetMinutes: person.tzOffsetMinutes,
        chatRef: person.chatRef,
      };
      this.users.set(person.email, user);
    } else if (!user.chatRef && person.chatRef) {
      user.chatRef = person.chatRef;
    }

    const existing = [...this.participants.values()].find(
      (p) => p.userId === user!.userId && p.role === person.role,
    );
    if (existing) return { participantId: existing.participantId };

    const participant: StoredParticipant = {
      participantId: this.ids.next("prt"),
      userId: user.userId,
      role: person.role,
      consent: { ...this.defaultConsent },
    };
    this.participants.set(participant.participantId, participant);
    await this.log.emit({
      orgId: this.orgId,
      name: "participant.enrolled",
      subjectRef: subjectRef("participant", participant.participantId),
      payload: { email: person.email, role: person.role },
    });
    return { participantId: participant.participantId };
  }

  async createPairing(input: {
    pairKey: string;
    mentorParticipantId: string;
    menteeParticipantId: string;
    state: PairingState;
    origin: PairingOrigin;
    cadenceOverride: Record<string, unknown> | null;
    startsAt: string | null;
    notes: string | null;
    importFileHash: string;
  }): Promise<{ pairingId: string }> {
    const pairingId = this.ids.next("pai");
    this.pairings.set(pairingId, {
      pairingId,
      pairKey: input.pairKey,
      mentorParticipantId: input.mentorParticipantId,
      menteeParticipantId: input.menteeParticipantId,
      state: input.state,
      origin: input.origin,
      cadenceOverride: input.cadenceOverride,
      lastSessionAt: null,
      documentRef: null,
      threadChannelId: null,
      notes: input.notes,
    });
    return { pairingId };
  }

  /**
   * The same announcement a matched pair makes. Everything downstream keys off
   * this event and cannot tell that the pair came out of a spreadsheet.
   */
  async announce(input: {
    pairingId: string;
    state: PairingState;
    participantIds: string[];
  }): Promise<void> {
    await this.log.emit({
      orgId: this.orgId,
      name: input.state === "active" ? "pair.activated" : "pair.offered",
      subjectRef: subjectRef("pairing", input.pairingId),
      payload: { participantIds: input.participantIds },
    });
  }

  pairKeys(): Set<string> {
    return new Set([...this.pairings.values()].map((p) => p.pairKey));
  }

  mentorLoad(): Map<string, number> {
    const load = new Map<string, number>();
    for (const pairing of this.pairings.values()) {
      const mentor = this.participants.get(pairing.mentorParticipantId);
      if (!mentor) continue;
      const user = [...this.users.values()].find(
        (u) => u.userId === mentor.userId,
      );
      if (!user) continue;
      load.set(user.email, (load.get(user.email) ?? 0) + 1);
    }
    return load;
  }

  participantsByEmail(): Map<string, { participantId: string; role: string }> {
    const out = new Map<string, { participantId: string; role: string }>();
    for (const participant of this.participants.values()) {
      const user = [...this.users.values()].find(
        (u) => u.userId === participant.userId,
      );
      if (user) {
        out.set(user.email, {
          participantId: participant.participantId,
          role: participant.role,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Projections — in Postgres these are outbox-relay subscribers
  // -------------------------------------------------------------------------

  private project(event: {
    name: string;
    subjectRef: string;
    payload: Record<string, unknown>;
  }): void {
    if (event.name === "agreement.opened") {
      const id = String(event.payload["agreementId"]);
      this.agreements.set(id, {
        id,
        subject: "session_time",
        pairingId: String(event.payload["pairingId"]),
        participantIds: (event.payload["participantIds"] as string[]) ?? [],
        options: (event.payload["options"] as Agreement["options"]) ?? [],
        responses: [],
        round: Number(event.payload["round"] ?? 1),
        openedAt: this.clock.iso(),
        timeoutAt: String(event.payload["timeoutAt"]),
      });
      return;
    }

    if (event.name === "session.scheduled") {
      const sessionId = String(event.payload["sessionId"]);
      const pairingId = idFromRef(event.subjectRef);
      this.sessions.set(sessionId, {
        sessionId,
        pairingId,
        startsAt: String(event.payload["startsAt"]),
        endsAt: String(event.payload["endsAt"]),
        calendarEventId: String(event.payload["calendarEventId"] ?? ""),
        transcriptionEnabled: Boolean(event.payload["transcriptionEnabled"]),
        state: "scheduled",
      });
      return;
    }

    if (event.name === "session.held") {
      const pairingId = idFromRef(event.subjectRef);
      const pairing = this.pairings.get(pairingId);
      if (pairing) pairing.lastSessionAt = this.clock.iso();
      return;
    }

    if (event.name === "document.rendered") {
      const pairingId = idFromRef(event.subjectRef);
      const pairing = this.pairings.get(pairingId);
      const docRef = event.payload["docRef"];
      if (pairing && typeof docRef === "string") pairing.documentRef = docRef;
      return;
    }

    if (event.name === "pair.thread_bound") {
      const pairing = this.pairings.get(idFromRef(event.subjectRef));
      const channelId = event.payload["channelId"];
      if (pairing && typeof channelId === "string") {
        pairing.threadChannelId = channelId;
      }
      return;
    }

    if (event.name === "extraction.completed") {
      // In Postgres this is the `extractions` row; here it is the one thing
      // anything needs off it — which pair a confirmation belongs to.
      const extractionId = event.payload["extractionId"];
      if (typeof extractionId === "string") {
        this.extractionPairings.set(extractionId, idFromRef(event.subjectRef));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Simulated humans — what the API layer does when a real person clicks
  // -------------------------------------------------------------------------

  /**
   * The in-memory `PairPreferencesStore`: what `PostgresPairPreferencesStore`
   * does, against the maps. Null for a stranger or a finished pairing, so the
   * same membership rule is exercised without a database.
   */
  async pairPreferencesContext(input: {
    pairingId: string;
    participantId: string;
  }): Promise<{
    sessionMinutes: number;
    everyDays: number;
    policy: ProgramPolicy["pairPreferences"];
  } | null> {
    const pairing = this.preferencePairing(input);
    if (!pairing) return null;
    const cadence = resolveCadence(this.policy.cadence, null, pairing.cadenceOverride);
    return {
      sessionMinutes: cadence.sessionMinutes,
      everyDays: cadence.everyDays,
      policy: this.policy.pairPreferences,
    };
  }

  async updatePairPreferences(input: {
    pairingId: string;
    participantId: string;
    preferences: PairPreferences;
  }): Promise<
    | { ok: true; sessionMinutes: number; everyDays: number }
    | { ok: false; reason: "not_member" | "disabled" }
  > {
    const pairing = this.preferencePairing(input);
    if (!pairing) return { ok: false, reason: "not_member" };
    if (!this.policy.pairPreferences.enabled) return { ok: false, reason: "disabled" };
    pairing.cadenceOverride = applyPairPreferences(
      pairing.cadenceOverride as Partial<Cadence> | null,
      input.preferences,
    );
    const cadence = resolveCadence(this.policy.cadence, null, pairing.cadenceOverride);
    await this.log.emit({
      orgId: this.orgId,
      name: "pair.preferences_updated",
      subjectRef: subjectRef("pairing", input.pairingId),
      payload: {
        pairingId: input.pairingId,
        participantId: input.participantId,
        sessionMinutes: cadence.sessionMinutes,
        everyDays: cadence.everyDays,
        changed: input.preferences,
      },
    });
    return {
      ok: true,
      sessionMinutes: cadence.sessionMinutes,
      everyDays: cadence.everyDays,
    };
  }

  private preferencePairing(input: {
    pairingId: string;
    participantId: string;
  }): StoredPairing | null {
    const pairing = this.pairings.get(input.pairingId);
    if (!pairing) return null;
    if (
      pairing.mentorParticipantId !== input.participantId &&
      pairing.menteeParticipantId !== input.participantId
    ) {
      return null;
    }
    return ["offered", "accepted", "active", "paused"].includes(pairing.state)
      ? pairing
      : null;
  }

  async respond(
    agreementId: string,
    participantId: string,
    kind: ResponseKind,
    optionId?: string,
    counter?: ProposalOption,
  ): Promise<void> {
    const agreement = this.agreements.get(agreementId);
    if (!agreement) throw new Error(`unknown agreement ${agreementId}`);
    const response: AgreementResponse = {
      participantId,
      kind,
      optionId,
      counter,
      at: this.clock.iso(),
    };
    this.agreements.set(agreementId, recordResponse(agreement, response));
    // Note the subject: agreement events are addressed to the agreement, which
    // is what the saga's waitFor pattern is keyed on.
    await this.log.emit({
      orgId: this.orgId,
      name: "agreement.responded",
      subjectRef: subjectRef("agreement", agreementId),
      payload: { agreementId, participantId, kind, optionId },
    });
  }

  /**
   * `noteId` is supplied when the note came from a real surface that has its
   * own stable id for it (a Slack message `ts`), which is also what makes a
   * redelivery of that message a no-op rather than a second note.
   */
  async submitNotes(
    pairingId: string,
    body: string,
    noteId?: string,
  ): Promise<void> {
    const id = noteId ?? this.ids.next("not");
    const key = `${pairingId}:${id}`;
    if (this.submittedNoteIds.has(key)) return;
    this.submittedNoteIds.add(key);
    await this.log.emit({
      orgId: this.orgId,
      name: "notes.submitted",
      subjectRef: subjectRef("pairing", pairingId),
      payload: { noteId: id, body },
    });
  }

  async confirmExtraction(
    pairingId: string,
    participantId: string,
    edited = false,
  ): Promise<void> {
    await this.log.emit({
      orgId: this.orgId,
      name: edited ? "extraction.edited" : "extraction.confirmed",
      subjectRef: subjectRef("pairing", pairingId),
      payload: { participantId },
    });
  }

  /**
   * What the Slack interaction endpoint does with a Confirm/Edit click: resolve
   * the extraction to its pair, check the clicker is a party to it, write the
   * verdict. The Postgres counterpart reads the same two facts out of the
   * event log and the `pairings` row.
   */
  async respondToExtraction(input: {
    extractionId: string;
    participantId: string;
    kind: "confirm" | "edit";
  }): Promise<void> {
    const pairingId = this.extractionPairings.get(input.extractionId);
    if (!pairingId) {
      throw new Error(`unknown extraction ${input.extractionId}`);
    }
    const pairing = this.pairings.get(pairingId);
    if (
      !pairing ||
      ![pairing.mentorParticipantId, pairing.menteeParticipantId].includes(
        input.participantId,
      )
    ) {
      throw new Error(
        `${input.participantId} is not a party to extraction ${input.extractionId}`,
      );
    }
    await this.log.emit({
      orgId: this.orgId,
      name: input.kind === "edit" ? "extraction.edited" : "extraction.confirmed",
      subjectRef: subjectRef("pairing", pairingId),
      payload: {
        extractionId: input.extractionId,
        participantId: input.participantId,
      },
    });
  }

  /** Channel id -> the pair whose thread it is, from `pair.thread_bound`. */
  resolvePairingByChannel(
    channelId: string,
  ): { pairingId: string; participantIds: string[] } | null {
    const pairing = [...this.pairings.values()].find(
      (p) => p.threadChannelId === channelId,
    );
    if (!pairing) return null;
    return {
      pairingId: pairing.pairingId,
      participantIds: [
        pairing.mentorParticipantId,
        pairing.menteeParticipantId,
      ],
    };
  }

  async submitFeedback(
    pairingId: string,
    participantId: string,
    score: number,
  ): Promise<void> {
    this.feedback.push({ sessionId: "latest", participantId, score });
    await this.log.emit({
      orgId: this.orgId,
      name: "feedback.submitted",
      subjectRef: subjectRef("pairing", pairingId),
      payload: { participantId, score },
    });
  }

  async cancelSession(pairingId: string, calendarEventId: string): Promise<void> {
    await this.log.emit({
      orgId: this.orgId,
      name: "session.cancelled",
      subjectRef: subjectRef("pairing", pairingId),
      payload: { calendarEventId },
    });
  }

  latestAgreementFor(pairingId: string): Agreement | null {
    const mine = [...this.agreements.values()].filter(
      (a) => a.pairingId === pairingId,
    );
    return mine[mine.length - 1] ?? null;
  }

  /**
   * What a Postgres `identity_links` lookup joined to `participants` would
   * return. Exists so a real interaction handler (see
   * `@mentorship/integrations`'s `ChatIdentityResolver`) can be exercised
   * against this in-memory world instead of only against mocks.
   */
  resolveParticipantIdByChatRef(chatRef: string): string | null {
    const user = [...this.users.values()].find((u) => u.chatRef === chatRef);
    if (!user) return null;
    const participant = [...this.participants.values()].find(
      (p) => p.userId === user.userId,
    );
    return participant?.participantId ?? null;
  }
}

function idFromRef(ref: string): string {
  const [, id] = ref.split(":");
  return id ?? "";
}
