import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler.js";

/**
 * Pure timing mechanics — no database, no clock but the one the test hands
 * in. This is the part of "schedule runNudgeSweep / runProgressSweep / the
 * digest" that has no dependency on Postgres being up, so it runs in the
 * default `pnpm test` suite rather than the DATABASE_URL-gated one.
 */
describe("Scheduler", () => {
  it("runs a job the first time it is ticked, whatever its interval", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({ jobs: [{ name: "a", intervalMs: 60_000, run }] });

    const result = await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ran).toEqual(["a"]);
  });

  it("does not re-run a job before its interval has elapsed", async () => {
    let now = 0;
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      jobs: [{ name: "a", intervalMs: 1000, run }],
      now: () => new Date(now),
    });

    await scheduler.tick();
    now += 500;
    const second = await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(second.ran).toEqual([]);
  });

  it("runs again once the interval has elapsed — safe to call every worker-loop tick", async () => {
    let now = 0;
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      jobs: [{ name: "a", intervalMs: 1000, run }],
      now: () => new Date(now),
    });

    await scheduler.tick();
    now += 1000;
    const second = await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(2);
    expect(second.ran).toEqual(["a"]);
  });

  it("never overlaps a job with itself — a slow run is not started twice", async () => {
    let resolveFirst!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const run = vi.fn().mockReturnValue(inFlight);
    let now = 0;
    const scheduler = new Scheduler({
      jobs: [{ name: "a", intervalMs: 0, run }],
      now: () => new Date(now),
    });

    const firstTick = scheduler.tick();
    // The job is now "running"; a second tick at the same instant (interval
    // 0, so it would otherwise be "due") must not start it again.
    const secondResult = await scheduler.tick();
    expect(secondResult.ran).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstTick;

    // Once it has finished, a later tick is free to run it again.
    now += 1;
    const thirdResult = await scheduler.tick();
    expect(thirdResult.ran).toEqual(["a"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs independent jobs on their own schedules", async () => {
    let now = 0;
    const fast = vi.fn().mockResolvedValue(undefined);
    const slow = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      jobs: [
        { name: "fast", intervalMs: 100, run: fast },
        { name: "slow", intervalMs: 1000, run: slow },
      ],
      now: () => new Date(now),
    });

    await scheduler.tick(); // both due (first run)
    now += 100;
    const second = await scheduler.tick(); // only fast is due again
    expect(second.ran).toEqual(["fast"]);
    now += 900;
    const third = await scheduler.tick(); // both due again
    expect(third.ran.sort()).toEqual(["fast", "slow"]);
  });

  it("catches a job's rejection, reports it, and still ticks the others", async () => {
    const onWarn = vi.fn();
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const ok = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      jobs: [
        { name: "failing", intervalMs: 0, run: failing },
        { name: "ok", intervalMs: 0, run: ok },
      ],
      onWarn,
    });

    const result = await scheduler.tick();

    expect(result.ran).toEqual(["ok"]);
    expect(onWarn).toHaveBeenCalledWith(
      "scheduled sweep failed",
      expect.objectContaining({ job: "failing", error: "boom" }),
    );
  });

  it("backs off for a full interval after a failure rather than retrying every tick", async () => {
    let now = 0;
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      jobs: [{ name: "a", intervalMs: 1000, run }],
      now: () => new Date(now),
      onWarn: () => {},
    });

    await scheduler.tick(); // fails
    now += 500;
    await scheduler.tick(); // not due yet — must not retry immediately
    expect(run).toHaveBeenCalledTimes(1);

    now += 500;
    const third = await scheduler.tick();
    expect(third.ran).toEqual(["a"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * Org-scoping is enforced by construction, not by the scheduler: every
   * `SweepJob.run` closure passed in already belongs to one worker's own
   * `orgId` (see `worker.ts` — `createProgressSweepRunner`/
   * `createNudgeSweepRunner`/the digest closure are all built from
   * `options.orgId`). What this proves is the half the scheduler is
   * actually responsible for: two independent schedules (as two workers,
   * one per org, would be) never share state or influence each other's
   * timing.
   */
  it("keeps two schedulers (one per org) from influencing each other's timing", async () => {
    let now = 0;
    const orgARun = vi.fn().mockResolvedValue(undefined);
    const orgBRun = vi.fn().mockResolvedValue(undefined);
    const orgAScheduler = new Scheduler({
      jobs: [{ name: "nudge", intervalMs: 1000, run: orgARun }],
      now: () => new Date(now),
    });
    const orgBScheduler = new Scheduler({
      jobs: [{ name: "nudge", intervalMs: 1000, run: orgBRun }],
      now: () => new Date(now),
    });

    await orgAScheduler.tick();
    expect(orgARun).toHaveBeenCalledTimes(1);
    expect(orgBRun).toHaveBeenCalledTimes(0);

    now += 1000;
    await orgBScheduler.tick();
    expect(orgARun).toHaveBeenCalledTimes(1); // untouched by org B's tick
    expect(orgBRun).toHaveBeenCalledTimes(1);
  });
});
