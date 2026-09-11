import type { DomainEvent } from "@mentorship/core";
import type { EventLog } from "@mentorship/events";
import type { SagaEngine } from "./engine.js";

/**
 * The outbox relay, in miniature.
 *
 * Effects emit events, and those events advance sagas — so delivering them
 * synchronously from inside an effect would re-enter the engine mid-transition
 * and corrupt the version check. Events are queued instead and drained after
 * the current step has been persisted. In production this is a relay process
 * reading the `events` table, which gets you the same ordering guarantee for
 * the same reason.
 */
export class Dispatcher {
  private readonly queue: DomainEvent[] = [];

  constructor(
    private readonly log: EventLog,
    private readonly engine: SagaEngine,
  ) {
    this.log.on((event) => {
      this.queue.push(event);
    });
  }

  /** Drains queued events, then fires due timers, until nothing moves. */
  async settle(maxRounds = 200): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      const event = this.queue.shift();
      if (event) {
        await this.engine.deliver(event);
        continue;
      }
      const fired = await this.engine.tick();
      if (fired === 0) return;
    }
    throw new Error("dispatcher did not settle — probable event/timer loop");
  }

  get pending(): number {
    return this.queue.length;
  }
}
