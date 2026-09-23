/**
 * The journey clock: time is an assignment, never a sleep.
 *
 * It *ticks* — every read advances it by one millisecond. A frozen clock would
 * be simpler and wrong in a way that matters: the outbox relay claims rows
 * `ORDER BY occurred_at`, and with every event in a drain stamped with the
 * same instant that order is whatever the heap happens to return. A real clock
 * never produces exact ties, so a frozen one would test an ordering production
 * cannot have. One millisecond per read keeps emission order and occurrence
 * order the same thing, and stays deterministic: two identical runs read the
 * clock the same number of times.
 */
export class JourneyClock {
  private ms: number;

  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
    if (Number.isNaN(this.ms)) throw new Error(`bad start time ${startIso}`);
  }

  /** Passed as `now` to the worker, the API and every port behind it. */
  readonly now = (): Date => {
    this.ms += 1;
    return new Date(this.ms);
  };

  /** The current instant without advancing — for building request timestamps. */
  peek(): Date {
    return new Date(this.ms);
  }

  advanceTo(iso: string): void {
    const target = Date.parse(iso);
    if (Number.isNaN(target)) throw new Error(`bad time ${iso}`);
    // Going backwards is always a journey bug: it would make a timer that
    // already fired look like it had not.
    if (target < this.ms) {
      throw new Error(`clock cannot go backwards: ${this.peek().toISOString()} -> ${iso}`);
    }
    this.ms = target;
  }

  advanceBy(by: { days?: number; hours?: number; minutes?: number }): void {
    const delta =
      (by.days ?? 0) * 86_400_000 + (by.hours ?? 0) * 3_600_000 + (by.minutes ?? 0) * 60_000;
    this.advanceTo(new Date(this.ms + delta).toISOString());
  }
}
