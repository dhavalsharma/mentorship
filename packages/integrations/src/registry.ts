import type {
  Adapter,
  AdapterCapabilities,
  IntegrationProfile,
  SlotName,
} from "@mentorship/core";
import { SLOT_NAMES } from "@mentorship/core";

/**
 * Eight slots, bound per program from `program.integrations`. This is the
 * answer to "can we run on Teams instead of Slack, and put the write-up in
 * Notion instead of Google Docs" — it is configuration, not a fork.
 *
 * Capabilities are PROBED, once per binding, and cached. Whether a tenant can
 * actually get an automatic meeting transcript depends on their subscription
 * edition, their admin's policy and sometimes the organiser's own licence —
 * none of which is inferable from "they use Google".
 */
export class IntegrationRegistry {
  private readonly adapters = new Map<SlotName, Adapter>();
  private readonly probed = new Map<SlotName, AdapterCapabilities>();

  bind(adapter: Adapter): this {
    this.adapters.set(adapter.slot, adapter);
    this.probed.delete(adapter.slot);
    return this;
  }

  get<T extends Adapter>(slot: SlotName): T | null {
    return (this.adapters.get(slot) as T | undefined) ?? null;
  }

  /** Throws only where the caller has already checked the slot is bound. */
  require<T extends Adapter>(slot: SlotName): T {
    const adapter = this.get<T>(slot);
    if (!adapter) throw new Error(`no adapter bound to slot "${slot}"`);
    return adapter;
  }

  async capabilities(slot: SlotName): Promise<AdapterCapabilities | null> {
    const adapter = this.adapters.get(slot);
    if (!adapter) return null;
    const cached = this.probed.get(slot);
    if (cached) return cached;
    const caps = await adapter.probe();
    this.probed.set(slot, caps);
    return caps;
  }

  /** Force a re-probe — entitlements change when an admin changes a setting. */
  invalidate(slot?: SlotName): void {
    if (slot) this.probed.delete(slot);
    else this.probed.clear();
  }

  boundSlots(): SlotName[] {
    return SLOT_NAMES.filter((s) => this.adapters.has(s));
  }

  emptySlots(): SlotName[] {
    return SLOT_NAMES.filter((s) => !this.adapters.has(s));
  }

  /**
   * Bind from a program's profile against a catalogue of available adapters.
   * A slot naming an adapter that is not installed is reported, never silently
   * ignored — that failure mode produces a program that mysteriously sends no
   * messages.
   */
  static fromProfile(
    profile: IntegrationProfile,
    catalogue: Adapter[],
  ): { registry: IntegrationRegistry; missing: { slot: SlotName; wanted: string }[] } {
    const byId = new Map(catalogue.map((a) => [`${a.slot}:${a.id}`, a]));
    const registry = new IntegrationRegistry();
    const missing: { slot: SlotName; wanted: string }[] = [];

    for (const slot of SLOT_NAMES) {
      const wanted = profile[slot];
      if (!wanted) continue;
      const adapter = byId.get(`${slot}:${wanted}`);
      if (adapter) registry.bind(adapter);
      else missing.push({ slot, wanted });
    }
    return { registry, missing };
  }
}

/**
 * What the saga loses when a slot is empty. Kept as data so the admin UI can
 * show an org exactly what it is giving up before it saves a profile.
 */
export const DEGRADATION: Record<SlotName, string> = {
  conversation:
    "Proposals and confirmations move to the in-app thread plus an email digest.",
  dm: "Reminders and feedback requests fall back to email.",
  calendar:
    "Times are proposed from stated availability and the pair books the invite themselves.",
  conferencing: "A plain link is shared; the transcript path is skipped.",
  transcript: "Both parties are asked for notes after every session.",
  document: "The write-up lives on an internal page at a stable URL.",
  sheet: "No tabular export; the dashboard is the only reporting surface.",
  dashboard: "Reporting is available through the API only.",
};
