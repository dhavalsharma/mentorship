import type {
  AdapterCapabilities,
  CalendarAdapter,
  CalendarEventRef,
  Interval,
} from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";

/**
 * Google Calendar adapter.
 *
 * STATUS: the API shapes are real; this has not been run against a live
 * tenant. Supply an access token (domain-wide delegated service account, or an
 * OAuth token for the organiser) to use it.
 */

export type GoogleTransport = (
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
) => Promise<Record<string, unknown>>;

export function httpGoogleTransport(accessToken: string): GoogleTransport {
  return async (path, init) => {
    const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`google calendar ${path} failed: ${JSON.stringify(json)}`);
    }
    return json;
  };
}

export interface GoogleCalendarOptions {
  /**
   * Whether this tenant is entitled to automatic meeting transcripts.
   *
   * Deliberately injected rather than inferred. Entitlement depends on the
   * Workspace edition, admin policy, and sometimes the organiser's individual
   * licence, and it is not reliably discoverable from the Calendar API — so
   * the platform probes it once per tenant at connect time (an admin confirms,
   * or a test meeting is checked) and caches the answer on the binding.
   *
   * Getting this wrong in the optimistic direction means the saga waits for a
   * transcript that will never arrive, so the default is the pessimistic one.
   */
  transcriptEntitlement?: "native" | "none";
  calendarId?: string;
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly slot = "calendar" as const;
  readonly id = "google";
  private readonly calendarId: string;

  constructor(
    private readonly call: GoogleTransport,
    private readonly opts: GoogleCalendarOptions = {},
  ) {
    this.calendarId = opts.calendarId ?? "primary";
  }

  async probe(): Promise<AdapterCapabilities> {
    await this.call("/users/me/calendarList", { method: "GET" });
    return AdapterCapabilitiesSchema.parse({
      freeBusy: true,
      createEventWithConference: true,
      autoTranscription: this.opts.transcriptEntitlement ?? "none",
      identityMapping: "verified",
    });
  }

  async freeBusy(input: {
    memberRefs: string[];
    window: Interval;
  }): Promise<Record<string, Interval[]>> {
    const res = await this.call("/freeBusy", {
      method: "POST",
      body: {
        timeMin: input.window.start,
        timeMax: input.window.end,
        items: input.memberRefs.map((id) => ({ id })),
      },
    });
    const calendars =
      (res["calendars"] as Record<
        string,
        { busy?: { start: string; end: string }[] }
      >) ?? {};
    const out: Record<string, Interval[]> = {};
    for (const ref of input.memberRefs) {
      out[ref] = calendars[ref]?.busy ?? [];
    }
    return out;
  }

  async createEvent(input: {
    memberRefs: string[];
    start: string;
    end: string;
    title: string;
    description: string;
    withConference: boolean;
    withTranscription: boolean;
    idempotencyKey: string;
  }): Promise<CalendarEventRef> {
    const res = await this.call(`/calendars/${this.calendarId}/events`, {
      method: "POST",
      query: { conferenceDataVersion: "1", sendUpdates: "all" },
      body: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        attendees: input.memberRefs.map((email) => ({ email })),
        // The idempotency key doubles as the event id, which is what makes a
        // retried effect a no-op instead of a second invite. Google accepts
        // base32hex ids; normalise the key before sending.
        id: normaliseEventId(input.idempotencyKey),
        conferenceData: input.withConference
          ? {
              createRequest: {
                requestId: input.idempotencyKey,
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            }
          : undefined,
      },
    });
    const conference = res["conferenceData"] as
      | { entryPoints?: { uri?: string }[] }
      | undefined;
    return {
      adapterId: this.id,
      eventId: String(res["id"]),
      conferenceUrl: conference?.entryPoints?.[0]?.uri,
      // Recording and transcription are governed by Workspace admin policy and
      // edition, not by a field on this request. We record the intent; the
      // probe above is what decides whether the saga waits for a transcript.
      transcriptionEnabled:
        input.withTranscription &&
        (this.opts.transcriptEntitlement ?? "none") === "native",
      htmlLink: res["htmlLink"] as string | undefined,
    };
  }

  async getEvent(eventId: string): Promise<CalendarEventRef | null> {
    try {
      const res = await this.call(
        `/calendars/${this.calendarId}/events/${eventId}`,
        { method: "GET" },
      );
      if (res["status"] === "cancelled") return null;
      return {
        adapterId: this.id,
        eventId: String(res["id"]),
        transcriptionEnabled: false,
        htmlLink: res["htmlLink"] as string | undefined,
      };
    } catch {
      return null;
    }
  }
}

/** Google event ids are base32hex, 5–1024 chars. */
function normaliseEventId(key: string): string {
  const cleaned = key.toLowerCase().replace(/[^0-9a-v]/g, "");
  return cleaned.length >= 5 ? cleaned : `${cleaned}00000`.slice(0, 8);
}
