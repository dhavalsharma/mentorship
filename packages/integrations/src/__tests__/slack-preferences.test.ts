import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { defaultPolicy, PairPreferencesPolicySchema } from "@mentorship/core";
import {
  buildPreferencesModalView,
  handleSlackInteraction,
  parsePreferencesSubmission,
  parseSlackInteractionPayload,
  SlackConversationAdapter,
  type PairPreferencesStore,
  type PairPreferencesUpdateResult,
  type PreferencesModalContext,
  type SlackInteractionDeps,
} from "@mentorship/integrations";

/**
 * "Session preferences": a pair choosing its own length and rhythm, from the
 * button on the proposal through the modal to the store write. Every value is
 * a select or a number field — nothing is read out of prose (invariant 9).
 */

const SECRET = "shh-its-a-secret";
const NOW = new Date("2026-09-15T04:30:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(rawBody: string): string {
  return (
    "v0=" +
    createHmac("sha256", SECRET).update(`v0:${TS}:${rawBody}`).digest("hex")
  );
}

const headers = (body: string) => ({
  "x-slack-request-timestamp": TS,
  "x-slack-signature": sign(body),
});

const encode = (payload: unknown) =>
  `payload=${encodeURIComponent(JSON.stringify(payload))}`;

const CONTEXT: PreferencesModalContext = {
  sessionMinutes: 45,
  everyDays: 14,
  policy: defaultPolicy().pairPreferences,
};

function clickBody(): string {
  return encode({
    type: "block_actions",
    user: { id: "U-ARJUN" },
    trigger_id: "trg-1",
    actions: [
      {
        action_id: "preferences:pai_001",
        value: JSON.stringify({ pairingId: "pai_001", kind: "preferences" }),
      },
    ],
  });
}

function submissionBody(values: {
  session?: string;
  sessionCustom?: string;
  cadence?: string;
  cadenceCustom?: string;
}): string {
  const select = (v: string | undefined) =>
    v === undefined ? { selected_option: null } : { selected_option: { value: v } };
  return encode({
    type: "view_submission",
    user: { id: "U-ARJUN" },
    view: {
      callback_id: "pair_preferences",
      private_metadata: JSON.stringify({ pairingId: "pai_001" }),
      state: {
        values: {
          pref_session: { pref_session_value: select(values.session) },
          pref_session_custom: {
            pref_session_custom_value: { value: values.sessionCustom ?? null },
          },
          pref_cadence: { pref_cadence_value: select(values.cadence) },
          pref_cadence_custom: {
            pref_cadence_custom_value: { value: values.cadenceCustom ?? null },
          },
        },
      },
    },
  });
}

function deps(store?: Partial<PairPreferencesStore>): SlackInteractionDeps & {
  opened: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const opened = vi.fn(async () => {});
  const update = vi.fn(
    async (input: {
      preferences: { sessionMinutes?: number; everyDays?: number };
    }): Promise<PairPreferencesUpdateResult> => ({
      ok: true,
      sessionMinutes: input.preferences.sessionMinutes ?? 45,
      everyDays: input.preferences.everyDays ?? 14,
    }),
  );
  return {
    signingSecret: SECRET,
    identity: {
      resolveParticipantId: async (id) => (id === "U-ARJUN" ? "prt_arjun" : null),
    },
    responder: { respond: vi.fn(async () => {}) },
    preferences: {
      modals: { openPreferencesModal: opened },
      store: {
        context: vi.fn(async () => CONTEXT),
        update,
        ...store,
      },
    },
    now: () => NOW,
    opened,
    update,
  };
}

describe("the proposal's Session preferences button", () => {
  it("is added, keyed on the pairing, only when the saga asks for it", async () => {
    const calls: Record<string, unknown>[] = [];
    const adapter = new SlackConversationAdapter(async (_method, body) => {
      calls.push(body);
      return { ok: true, ts: "1.0" };
    });
    const base = {
      thread: { adapterId: "slack", channelId: "C1", threadId: null },
      agreementId: "agr_001",
      options: [],
      body: "pick one",
      idempotencyKey: "k",
    };
    await adapter.postProposal(base);
    await adapter.postProposal({ ...base, preferencesPairingId: "pai_001" });

    const elements = (call: Record<string, unknown>) =>
      ((call["blocks"] as { elements?: { action_id: string; value: string }[] }[])[1]!
        .elements ?? []);
    expect(elements(calls[0]!).map((e) => e.action_id)).not.toContain(
      "preferences:pai_001",
    );
    const button = elements(calls[1]!).find(
      (e) => e.action_id === "preferences:pai_001",
    )!;
    expect(JSON.parse(button.value)).toEqual({
      pairingId: "pai_001",
      kind: "preferences",
    });
  });

  it("parses as a preferences action, not an agreement one", () => {
    expect(parseSlackInteractionPayload(clickBody())).toEqual({
      target: "preferences",
      slackUserId: "U-ARJUN",
      actionId: "preferences:pai_001",
      pairingId: "pai_001",
      kind: "preferences",
      triggerId: "trg-1",
    });
  });
});

describe("opening the modal", () => {
  it("opens it inside the click's request, pre-filled with what the pair has now", async () => {
    const d = deps();
    const body = clickBody();
    const res = await handleSlackInteraction({ rawBody: body, headers: headers(body) }, d);
    expect(res.status).toBe(200);
    expect(d.opened).toHaveBeenCalledWith({
      triggerId: "trg-1",
      pairingId: "pai_001",
      context: CONTEXT,
    });
  });

  it("never shows the menu to someone who is not in the pair", async () => {
    const unhandled = vi.fn();
    const d = deps({ context: vi.fn(async () => null) });
    const body = clickBody();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: headers(body) },
      { ...d, onUnhandled: unhandled },
    );
    expect(res.status).toBe(200);
    expect(d.opened).not.toHaveBeenCalled();
    expect(unhandled).toHaveBeenCalledWith(
      "preferences_not_pair_member",
      expect.anything(),
    );
  });

  it("does not open the menu at all once the program has turned choice off", async () => {
    const unhandled = vi.fn();
    const d = deps({
      context: vi.fn(async () => ({
        ...CONTEXT,
        policy: PairPreferencesPolicySchema.parse({ enabled: false }),
      })),
    });
    const body = clickBody();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: headers(body) },
      { ...d, onUnhandled: unhandled },
    );
    expect(res.status).toBe(200);
    expect(d.opened).not.toHaveBeenCalled();
    expect(unhandled).toHaveBeenCalledWith("preferences_disabled", expect.anything());
  });

  it("acks and records it when preferences are not wired", async () => {
    const unhandled = vi.fn();
    const { preferences: _omit, ...rest } = deps();
    const body = clickBody();
    const res = await handleSlackInteraction(
      { rawBody: body, headers: headers(body) },
      { ...rest, onUnhandled: unhandled },
    );
    expect(res.status).toBe(200);
    expect(unhandled).toHaveBeenCalledWith(
      "preferences_modal_not_configured",
      expect.anything(),
    );
  });
});

describe("the modal view", () => {
  type Block = {
    block_id?: string;
    element?: {
      options?: { value: string }[];
      initial_option?: { value: string };
      initial_value?: string;
    };
  };
  const blocksOf = (view: Record<string, unknown>) => view["blocks"] as Block[];
  const block = (view: Record<string, unknown>, id: string) =>
    blocksOf(view).find((b) => b.block_id === id);

  it("builds its menu from policy and pre-selects current values", () => {
    const view = buildPreferencesModalView({ pairingId: "pai_001", context: CONTEXT });
    expect(view["callback_id"]).toBe("pair_preferences");
    expect(JSON.parse(String(view["private_metadata"]))).toEqual({
      pairingId: "pai_001",
    });
    const session = block(view, "pref_session")!.element!;
    expect(session.options!.map((o) => o.value)).toEqual(["15", "30", "45", "custom"]);
    expect(session.initial_option!.value).toBe("45");
    const cadence = block(view, "pref_cadence")!.element!;
    expect(cadence.options!.map((o) => o.value)).toEqual([
      "7",
      "14",
      "21",
      "28",
      "custom",
    ]);
    expect(cadence.initial_option!.value).toBe("14");
  });

  it("shows an off-menu current value as Custom with the number filled in", () => {
    const view = buildPreferencesModalView({
      pairingId: "pai_001",
      context: { ...CONTEXT, sessionMinutes: 60, everyDays: 30 },
    });
    expect(block(view, "pref_session")!.element!.initial_option!.value).toBe("custom");
    expect(block(view, "pref_session_custom")!.element!.initial_value).toBe("60");
    expect(block(view, "pref_cadence_custom")!.element!.initial_value).toBe("30");
  });

  it("drops the Custom option and field when the program does not allow them", () => {
    const view = buildPreferencesModalView({
      pairingId: "pai_001",
      context: {
        ...CONTEXT,
        policy: PairPreferencesPolicySchema.parse({
          allowCustomSessionMinutes: false,
          allowCustomCadenceDays: false,
        }),
      },
    });
    expect(block(view, "pref_session_custom")).toBeUndefined();
    expect(block(view, "pref_cadence_custom")).toBeUndefined();
    expect(
      block(view, "pref_session")!.element!.options!.map((o) => o.value),
    ).not.toContain("custom");
  });
});

describe("submitting the modal", () => {
  it("parses selects and number fields out of view state", () => {
    expect(
      parsePreferencesSubmission(
        submissionBody({ session: "custom", sessionCustom: "50", cadence: "21" }),
      ),
    ).toEqual({
      slackUserId: "U-ARJUN",
      pairingId: "pai_001",
      sessionChoice: "custom",
      sessionCustom: "50",
      cadenceChoice: "21",
      cadenceCustom: null,
    });
  });

  it("saves a valid choice and replaces the modal with what took", async () => {
    const d = deps();
    const body = submissionBody({ session: "30", cadence: "7" });
    const res = await handleSlackInteraction({ rawBody: body, headers: headers(body) }, d);
    expect(d.update).toHaveBeenCalledWith({
      pairingId: "pai_001",
      participantId: "prt_arjun",
      preferences: { sessionMinutes: 30, everyDays: 7 },
    });
    const parsed = JSON.parse(res.body!);
    expect(parsed.response_action).toBe("update");
    expect(JSON.stringify(parsed.view)).toContain("30-minute sessions, every week");
  });

  it("answers a bad custom value with an error under that field, writing nothing", async () => {
    const d = deps();
    const body = submissionBody({ session: "custom", sessionCustom: "500", cadence: "14" });
    const res = await handleSlackInteraction({ rawBody: body, headers: headers(body) }, d);
    expect(JSON.parse(res.body!)).toEqual({
      response_action: "errors",
      errors: { pref_session_custom: "Between 15 and 240 minutes." },
    });
    expect(d.update).not.toHaveBeenCalled();
  });

  it("refuses a stranger at submission too, not only at click time", async () => {
    const d = deps({ context: vi.fn(async () => null) });
    const body = submissionBody({ session: "30", cadence: "14" });
    const res = await handleSlackInteraction({ rawBody: body, headers: headers(body) }, d);
    expect(JSON.parse(res.body!).response_action).toBe("errors");
    expect(d.update).not.toHaveBeenCalled();
  });

  it("says the program turned choice off — not 'not your pair' — when that happens mid-modal", async () => {
    const d = deps({
      update: vi.fn(
        async (): Promise<PairPreferencesUpdateResult> => ({
          ok: false,
          reason: "disabled",
        }),
      ),
    });
    const body = submissionBody({ session: "30", cadence: "14" });
    const res = await handleSlackInteraction({ rawBody: body, headers: headers(body) }, d);
    expect(JSON.parse(res.body!)).toEqual({
      response_action: "errors",
      errors: {
        pref_session: "This program sets session length and rhythm for every pair.",
      },
    });
  });

  it("does not promise a thread announcement it cannot always make", () => {
    const view = buildPreferencesModalView({ pairingId: "pai_001", context: CONTEXT });
    const intro = JSON.stringify((view["blocks"] as unknown[])[0]);
    expect(intro).not.toContain("the thread is told when it changes");
    expect(intro).toContain("Between sessions");
  });

  it("still routes a counter-proposal submission to the counter handler", async () => {
    const d = deps();
    const body = encode({
      type: "view_submission",
      user: { id: "U-ARJUN" },
      view: {
        callback_id: "counter_proposal",
        private_metadata: JSON.stringify({ agreementId: "agr_001" }),
        state: { values: {} },
      },
    });
    const res = await handleSlackInteraction({ rawBody: body, headers: headers(body) }, d);
    // No counter resolver wired in these deps — the counter handler's own
    // answer, which proves the preferences handler never saw it.
    expect(JSON.parse(res.body!).errors).toHaveProperty("counter_date");
    expect(d.update).not.toHaveBeenCalled();
  });
});
