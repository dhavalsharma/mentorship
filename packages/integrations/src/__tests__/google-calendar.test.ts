import { describe, expect, it } from "vitest";
import { GoogleCalendarAdapter } from "@mentorship/integrations";
import { openReplay, warnOnStaleFixtures } from "./vendor-replay.js";

/**
 * `GoogleCalendarAdapter` against `tests/fixtures/vendor/google-calendar`
 * (tier 4). Before these fixtures the adapter had no transport-level test at
 * all — only `live-registry.test.ts`'s guard checks, which never reach it.
 */

warnOnStaleFixtures("google-calendar.test.ts");

const CAL = { calendarId: "sandbox-calendar", sendUpdates: "none" as const };

describe("GoogleCalendarAdapter", () => {
  it("probes with calendarList and reports no transcription unless told otherwise", async () => {
    const replay = openReplay();
    const caps = await new GoogleCalendarAdapter(replay.googleCalendar(), CAL).probe();
    expect(replay.calls[0]!.call).toBe("calendarList.list");
    expect(caps.freeBusy).toBe(true);
    expect(caps.autoTranscription).toBe("none");
  });

  it("maps the recorded freeBusy response per member, empty for anyone Google omits", async () => {
    const replay = openReplay();
    const busy = await new GoogleCalendarAdapter(replay.googleCalendar(), CAL).freeBusy({
      memberRefs: ["user1@example.com", "user2@example.com", "absent@example.com"],
      window: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" },
    });
    expect(busy["user1@example.com"]).toHaveLength(1);
    expect(busy["user2@example.com"]).toEqual([]);
    expect(busy["absent@example.com"]).toEqual([]);
  });

  it("creates the event with the idempotency key as its id and reads the Meet link back", async () => {
    const replay = openReplay();
    const ref = await new GoogleCalendarAdapter(replay.googleCalendar(), CAL).createEvent({
      memberRefs: ["user1@example.com", "user2@example.com"],
      start: "2026-09-24T09:00:00Z",
      end: "2026-09-24T09:45:00Z",
      title: "Priya & Sam: mentoring",
      description: "Booked by the mentorship bot.",
      withConference: true,
      withTranscription: false,
      idempotencyKey: "saga:1:book:0",
    });

    const call = replay.calls[0]!;
    expect(call.call).toBe("events.insert");
    expect(call.query).toEqual({ conferenceDataVersion: "1", sendUpdates: "none" });
    expect((call.body as { id: string }).id).toBe("saga1book0");
    expect(ref.conferenceUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(ref.eventId).toBe(replay.fixture("events.insert").response!["id"]);
  });

  it("reads an event back, and treats a cancelled one as gone", async () => {
    const replay = openReplay();
    const adapter = new GoogleCalendarAdapter(replay.googleCalendar(), CAL);
    expect(await adapter.getEvent("saga1book0")).toMatchObject({ eventId: "saga1book0" });

    replay.on("events.get", ({ response }) => ({ ...response, status: "cancelled" }));
    expect(await adapter.getEvent("saga1book0")).toBeNull();
  });
});
