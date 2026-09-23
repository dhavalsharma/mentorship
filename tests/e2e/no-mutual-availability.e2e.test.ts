import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney } from "./harness/journey.js";
import { agreementsOpened, named, ofKind } from "./harness/observe.js";
import { describeProperties, KNOWN_BUGS } from "./harness/properties.js";
import type { Stage, StageEvent } from "./harness/stage.js";
import { noMutualAvailability, WORKING_OFFSETS } from "./journeys/no-mutual-availability.js";

const localMinutes = (iso: string, offset: number): { day: number; minute: number } => {
  const t = Date.parse(iso) / 60_000 + offset;
  return { day: Math.floor(t / 1440), minute: ((t % 1440) + 1440) % 1440 };
};

describe("journey: no-mutual-availability", () => {
  let s: Stage;
  let log: StageEvent[];

  beforeAll(async () => {
    s = await runJourney(noMutualAvailability);
    log = await s.events();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("pauses the India–California pair with no_mutual_availability and offers it nothing", () => {
    const [ist_pst] = s.pairingIds;
    const escalated = named(log, "saga.escalated").filter(
      (e) => e.payload["pairingId"] === ist_pst,
    );
    expect(escalated.map((e) => e.payload["reason"])).toEqual(["no_mutual_availability"]);
    expect(agreementsOpened(log, ist_pst)).toEqual([]);
    expect(
      ofKind(s.calls(), "thread.created").filter((c) => c.detail["pairingId"] === ist_pst),
    ).toEqual([]);
  });

  it("offers the India–London pair only slots inside both working days (invariant 21)", () => {
    const [, ist_utc] = s.pairingIds;
    const [agreement] = agreementsOpened(log, ist_utc);
    expect(agreement!.options.length).toBeGreaterThan(0);
    for (const option of agreement!.options) {
      for (const offset of WORKING_OFFSETS[1]!) {
        const start = localMinutes(option.startsAt, offset);
        const end = localMinutes(option.endsAt, offset);
        expect(start.day).toBe(end.day);
        expect(start.minute).toBeGreaterThanOrEqual(9 * 60);
        expect(end.minute).toBeLessThanOrEqual(18 * 60);
      }
    }
  });
});

describeProperties(noMutualAvailability, {
  known: { P1: KNOWN_BUGS.redeliveredActivationRestartsPausedSaga },
});
