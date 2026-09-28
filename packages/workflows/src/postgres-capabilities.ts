import { and, eq, notInArray } from "drizzle-orm";
import {
  AdapterCapabilitiesSchema,
  type AdapterCapabilities,
  type SlotName,
} from "@mentorship/core";
import { integrationBindings, withTenant, type Db } from "@mentorship/db";
import type { IntegrationRegistry } from "@mentorship/integrations";

/**
 * ADR-0006's probe-and-cache, on Postgres: ask every adapter this process has
 * bound what it can actually do for this tenant, and write the answer onto
 * the org's `integration_bindings` row — the only place
 * `PostgresSagaResolvers.capabilities()` looks.
 *
 * Before this existed nothing wrote that column, so every slot of every real
 * Postgres tenant read as `null`: proposals always degraded to plain messages
 * and a transcript was never polled for. The in-memory path never showed it,
 * because `IntegrationRegistry.capabilities()` probes lazily in-process.
 *
 * When it runs — the worker's boot, for the worker's own `ORG_ID`, and again
 * on the worker's scheduler as a periodic refresh (`schedules.capabilityProbe`).
 * The ADR says "probed once at connect time", and in this repo the worker's
 * boot *is* connect time: it is the only process that constructs adapters,
 * and it constructs them once. The ADR also names the weakness — a cached
 * entitlement goes stale when an admin changes a setting and nothing tells
 * us — and leaves "scheduled refresh or only refresh-on-failure" open; the
 * refresh interval is the cheap half of that answer.
 *
 * Rejected: re-probing from `apps/api` when an admin saves settings. The API
 * process holds no adapters — it could only probe by constructing its own
 * copies from env and credentials, a second, divergent answer to "what is
 * bound", which is the exact two-readers bug `DocumentConfigFallback` exists
 * to prevent. A settings change also does not rebind the running worker's
 * adapter (those are resolved at boot), so the next boot's probe is the
 * first moment the new binding's capabilities mean anything. Also rejected:
 * probing lazily from the resolver on a cache miss. Resolvers are reads only
 * (invariant 4), and a miss that silently triggered a vendor call mid-step
 * would put a network dependency inside every saga transition.
 *
 * A probe that throws, times out or returns something the schema rejects is
 * recorded, not fatal: the row gets `capabilities = null` and the reason in
 * `last_error`, and `onWarn` says so. Null rather than `NO_CAPABILITIES`,
 * so "we could not find out" stays distinguishable from "we asked and it
 * can do nothing" — both degrade identically, but only one is a problem an
 * operator has to fix. Null rather than keeping a previous good answer,
 * because the ADR's default is the pessimistic one: the worst case is asking
 * for notes that were not needed, not waiting a day for a transcript.
 */

export interface ProbeCapabilitiesOptions {
  db: Db;
  orgId: string;
  registry: IntegrationRegistry;
  /** Passed to `withTenant`; see the note there about superuser connections. */
  role?: string;
  now?: () => Date;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
  /** A probe that has not answered by then is recorded as failed. Default 10s. */
  timeoutMs?: number;
}

export type SlotProbeResult =
  | { slot: SlotName; adapterId: string; ok: true; capabilities: AdapterCapabilities }
  | { slot: SlotName; adapterId: string; ok: false; error: string };

export interface ProbeCapabilitiesResult {
  probed: SlotProbeResult[];
  /**
   * Slots with a binding row but no adapter bound in this process — their
   * cached capabilities were cleared, since nothing can act on them. A stale
   * `autoTranscription: "native"` left behind by an earlier deploy would
   * otherwise send the saga polling for a transcript no adapter will fetch.
   */
  cleared: SlotName[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function probeAndCacheCapabilities(
  options: ProbeCapabilitiesOptions,
): Promise<ProbeCapabilitiesResult> {
  const { db, orgId, registry } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bound = registry.boundSlots();

  // Probes run outside the transaction: they are vendor calls, and holding a
  // connection open across a network round trip to Slack or Google is how a
  // slow vendor becomes a starved pool.
  const probed: SlotProbeResult[] = [];
  for (const slot of bound) {
    const adapter = registry.require(slot);
    try {
      const raw = await withTimeout(adapter.probe(), timeoutMs, `${slot} probe`);
      const capabilities = AdapterCapabilitiesSchema.parse(raw);
      probed.push({ slot, adapterId: adapter.id, ok: true, capabilities });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      probed.push({ slot, adapterId: adapter.id, ok: false, error: message });
      options.onWarn?.(
        "capability probe failed — slot recorded as unknown and will degrade until a probe succeeds",
        { orgId, slot, adapterId: adapter.id, error: message },
      );
    }
  }

  const at = now();
  const cleared = await withTenant(
    db,
    orgId,
    async (tx) => {
      for (const result of probed) {
        const values = {
          capabilities: result.ok ? result.capabilities : null,
          probedAt: at,
          lastError: result.ok ? null : result.error,
        };
        // Upsert on (org_id, slot), touching only the probe's own columns:
        // `config` belongs to the settings pages and is never rewritten here.
        // `adapter_id` is rewritten, because the capabilities describe the
        // adapter actually bound, not whichever one a settings page assumed.
        await tx
          .insert(integrationBindings)
          .values({ orgId, slot: result.slot, adapterId: result.adapterId, ...values })
          .onConflictDoUpdate({
            target: [integrationBindings.orgId, integrationBindings.slot],
            set: { adapterId: result.adapterId, ...values, updatedAt: at },
          });
      }
      const stale = await tx
        .update(integrationBindings)
        .set({ capabilities: null, probedAt: at, lastError: "no adapter bound", updatedAt: at })
        .where(
          and(
            eq(integrationBindings.orgId, orgId),
            ...(bound.length > 0 ? [notInArray(integrationBindings.slot, bound)] : []),
          ),
        )
        .returning({ slot: integrationBindings.slot });
      return stale.map((r) => r.slot as SlotName);
    },
    options.role === undefined ? {} : { role: options.role },
  );

  return { probed, cleared };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
