import { describe, it } from "vitest";

/**
 * `calendar-never-confirmed` — INFEASIBLE through the doors a journey has, so
 * skipped rather than faked.
 *
 * The `scheduling` state's 1h timeout pauses with `calendar_never_confirmed`
 * when `session.scheduled` never arrives. But the effect runner emits
 * `session.scheduled` in the same `create_calendar_event` effect that calls
 * the adapter: if `createEvent` throws, the step fails and is retried (the
 * saga never enters `scheduling`); if it returns, the event is written. A
 * crash between the two is retried too, and the idempotency key makes the
 * retry return the same invite. The only way to reach the timeout is for the
 * `session.scheduled` outbox row itself to be lost or dead-lettered — which
 * needs a direct write to `events`, or a projector fault this suite cannot
 * inject from outside. That the state is so hard to reach is arguably the
 * design working; the timeout is a backstop, not a path.
 */
describe("journey: calendar-never-confirmed", () => {
  it.skip("pauses with calendar_never_confirmed when the invite never comes back — no outside door loses session.scheduled", () => {});
});
