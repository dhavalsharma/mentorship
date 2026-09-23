import type { Adapter, AdapterCapabilities, DmAdapter } from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";
import { Recorder, type SlackTransport } from "@mentorship/integrations";

/**
 * The fakes stand in for Slack and Google, which are *outside* the system
 * under test: they persist across a worker restart, exactly as a real
 * workspace would, and they are what the recorder observes.
 */

/** `Recorder` stamped from the journey clock, so a call log is reproducible. */
export class ClockedRecorder extends Recorder {
  constructor(private readonly clock: () => Date) {
    super();
  }
  override record(kind: string, detail: Record<string, unknown>): void {
    this.calls.push({ kind, at: this.clock().toISOString(), detail });
  }
}

/**
 * One switch for "the process died mid-effect". Every adapter method call
 * passes through `around`; the Nth one either never starts (`before`) or
 * completes against the fake and then never returns (`after` — the effect
 * happened, the process died before it learned so). Either way the worker's
 * code is left awaiting a promise that never settles, which is what a crash
 * looks like from the inside.
 */
export class CrashSwitch {
  private count = 0;
  private armed: { atCall: number; mode: "before" | "after" } | null = null;
  private fired = false;
  private onFire: (() => void) | null = null;

  /** Adapter calls seen so far, across restarts — P2 enumerates up to this. */
  get calls(): number {
    return this.count;
  }

  get hasFired(): boolean {
    return this.fired;
  }

  arm(atCall: number, mode: "before" | "after"): void {
    this.armed = { atCall, mode };
  }

  /** Resolves when the armed call is reached. */
  whenFired(): Promise<void> {
    return new Promise((resolve) => {
      if (this.fired) resolve();
      else this.onFire = resolve;
    });
  }

  async around<T>(call: () => Promise<T>): Promise<T> {
    this.count += 1;
    const armed = this.armed;
    if (!armed || this.fired || this.count !== armed.atCall) return call();
    this.fired = true;
    if (armed.mode === "after") await call();
    this.onFire?.();
    return new Promise<T>(() => {});
  }
}

/**
 * Wraps every method except `probe` in the crash switch. A Proxy rather than a
 * per-slot wrapper so a new port method cannot silently escape the harness.
 */
export function instrument<T extends Adapter>(adapter: T, crash: CrashSwitch): T {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || prop === "probe") return value;
      return (...args: unknown[]) =>
        crash.around(() => Promise.resolve(value.apply(target, args)));
    },
  });
}

/** A DM slot that is bound and probes fine, and fails every send. */
export class DownDm implements DmAdapter {
  readonly slot = "dm" as const;
  readonly id = "down-dm";
  constructor(private readonly recorder: Recorder) {}
  async probe(): Promise<AdapterCapabilities> {
    return AdapterCapabilitiesSchema.parse({ identityMapping: "verified" });
  }
  async send(input: { memberRef: string }): Promise<{ messageRef: string }> {
    this.recorder.record("dm.failed", { to: input.memberRef });
    throw new Error("dm outage: 503 from the chat vendor");
  }
}

/**
 * The one Slack Web API call `apps/api` makes itself. Recording the view it
 * opened is what lets `submitModal` answer the modal the system actually
 * showed, rather than one the test imagined.
 */
export function recordingSlackTransport(recorder: Recorder): SlackTransport {
  return async (method, body) => {
    const view = (body["view"] ?? {}) as Record<string, unknown>;
    recorder.record(`slack.${method}`, {
      triggerId: body["trigger_id"] ?? null,
      callbackId: view["callback_id"] ?? null,
      privateMetadata: view["private_metadata"] ?? null,
    });
    return { ok: true };
  };
}
