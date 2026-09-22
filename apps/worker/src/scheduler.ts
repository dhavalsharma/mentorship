/**
 * Periodic (not per-event) sweeps for the worker loop.
 *
 * `createWorker`'s `pass()` already has a loop shape for this: drain the
 * outbox, then fire due timers, every `WORKER_INTERVAL_MS`. A sweep is a
 * third kind of tick — nothing schedules it in response to an event, because
 * the whole point (`packages/primitives/nudge/src/deficits.ts`'s opening
 * comment) is that these are about *absence*, which nothing subscribes to.
 * So this is ordinary interval polling, gated in-process, following the exact
 * reasoning ADR-0008 and `docs/ROADMAP.md` already give for not reaching for
 * pg-boss on the relay/timer loop: nothing here needs a single-runner
 * guarantee strongly enough to be worth a distributed lock that can only add
 * a way for the whole thing to wedge. Two workers ticking the same sweep on
 * the same schedule is merely redundant, not unsafe, as long as every sweep
 * underneath is itself idempotent — which is `runNudgeSweep` /
 * `runProgressSweep`'s job, not this file's.
 *
 * This file is deliberately DB-free and org-agnostic: a `SweepJob`'s `run`
 * closure is built by whoever assembles the worker (see `worker.ts`), already
 * scoped to that worker's one `orgId` — the same "one worker, one tenant"
 * shape `SagaStore.findDue(now, orgId)` and `relayOnce`'s claim query already
 * have. The scheduler's only job is *when*, never *what* or *which org*.
 */

export interface SweepJob {
  /** Used for `lastRunAt` bookkeeping and in `onWarn`/`ran` reporting. */
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface SchedulerOptions {
  jobs: SweepJob[];
  now?: () => Date;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface SchedulerTickResult {
  /** Names of the jobs that actually ran this tick, in configured order. */
  ran: string[];
}

export class Scheduler {
  private readonly lastRunAt = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(private readonly options: SchedulerOptions) {}

  /**
   * One check across every configured job: due and not already running, run
   * it; otherwise skip. Called every worker-loop iteration — most calls do
   * nothing, which is the point of an interval gate rather than a bespoke
   * per-job timer.
   */
  async tick(): Promise<SchedulerTickResult> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const ran: string[] = [];

    for (const job of this.options.jobs) {
      // A job still in flight from a previous tick is never started again —
      // the overlap guard that keeps "safe to double-run" true even when a
      // sweep takes longer than its own interval, without needing a DB lock
      // for it.
      if (this.running.has(job.name)) continue;

      const last = this.lastRunAt.get(job.name);
      if (last !== undefined && now - last < job.intervalMs) continue;

      // Recorded before the run resolves, not after: a job that is due this
      // tick and then throws should back off for a full interval before
      // being retried, not spin on every subsequent tick until it succeeds —
      // the same backoff shape a throwing outbox subscriber already gets in
      // `relayOnce`.
      this.lastRunAt.set(job.name, now);
      this.running.add(job.name);
      try {
        await job.run();
        ran.push(job.name);
      } catch (error) {
        this.options.onWarn?.("scheduled sweep failed", {
          job: job.name,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.running.delete(job.name);
      }
    }

    return { ran };
  }
}
