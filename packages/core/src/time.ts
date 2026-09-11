import type { Interval, ProposalOption } from "./capabilities.js";

/**
 * Interval maths for scheduling. Availability is handled as UTC instants
 * throughout — never as "Tuesday 3pm" — because storing wall-clock strings
 * produces silently wrong overlaps across timezones and DST that look like
 * matching bugs for months.
 *
 * SIMPLIFICATION: a participant's timezone is a fixed offset in minutes. That
 * is correct for a scaffold and wrong twice a year. Replace `tzOffsetMinutes`
 * with an IANA zone id and resolve offsets per-instant (Temporal, or luxon)
 * before this touches a real cohort spanning a DST boundary.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Span {
  start: number;
  end: number;
}

const toSpan = (i: Interval): Span => ({
  start: Date.parse(i.start),
  end: Date.parse(i.end),
});
const toInterval = (s: Span): Interval => ({
  start: new Date(s.start).toISOString(),
  end: new Date(s.end).toISOString(),
});

export const iso = (ms: number): string => new Date(ms).toISOString();
export const addMinutes = (at: string, n: number): string =>
  iso(Date.parse(at) + n * MINUTE);
export const addHours = (at: string, n: number): string =>
  iso(Date.parse(at) + n * HOUR);
export const addDays = (at: string, n: number): string =>
  iso(Date.parse(at) + n * DAY);
export const hoursBetween = (a: string, b: string): number =>
  (Date.parse(b) - Date.parse(a)) / HOUR;

function normalize(spans: Span[]): Span[] {
  const valid = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of valid) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function intersectSpans(a: Span[], b: Span[]): Span[] {
  const left = normalize(a);
  const right = normalize(b);
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;
    const start = Math.max(l.start, r.start);
    const end = Math.min(l.end, r.end);
    if (end > start) out.push({ start, end });
    if (l.end < r.end) i++;
    else j++;
  }
  return out;
}

function subtractSpans(bases: Span[], busy: Span[]): Span[] {
  const blocked = normalize(busy);
  let current = normalize(bases);
  for (const b of blocked) {
    const next: Span[] = [];
    for (const c of current) {
      if (b.end <= c.start || b.start >= c.end) {
        next.push(c);
        continue;
      }
      if (b.start > c.start) next.push({ start: c.start, end: b.start });
      if (b.end < c.end) next.push({ start: b.end, end: c.end });
    }
    current = next;
  }
  return normalize(current);
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  return intersectSpans(a.map(toSpan), b.map(toSpan)).map(toInterval);
}

export function subtractIntervals(
  bases: Interval[],
  busy: Interval[],
): Interval[] {
  return subtractSpans(bases.map(toSpan), busy.map(toSpan)).map(toInterval);
}

/**
 * Daily working windows for one participant, expressed in UTC.
 * Weekends are excluded — override by passing `includeWeekends`.
 */
export function workingWindows(input: {
  from: string;
  days: number;
  tzOffsetMinutes: number;
  startHour: number;
  endHour: number;
  includeWeekends?: boolean;
}): Interval[] {
  const fromMs = Date.parse(input.from);
  const horizonEnd = fromMs + input.days * DAY;
  const offset = input.tzOffsetMinutes * MINUTE;
  const localNow = fromMs + offset;
  const localDayStart = Math.floor(localNow / DAY) * DAY;

  const out: Span[] = [];
  for (let d = 0; d <= input.days; d++) {
    const dayStartLocal = localDayStart + d * DAY;
    if (!input.includeWeekends) {
      // 1970-01-01 was a Thursday; day 4 of the cycle is Saturday.
      const dow = (Math.floor(dayStartLocal / DAY) + 4) % 7;
      if (dow === 6 || dow === 0) continue; // Sat, Sun
    }
    const startUtc = dayStartLocal + input.startHour * HOUR - offset;
    const endUtc = dayStartLocal + input.endHour * HOUR - offset;
    const clippedStart = Math.max(startUtc, fromMs);
    const clippedEnd = Math.min(endUtc, horizonEnd);
    if (clippedEnd > clippedStart) out.push({ start: clippedStart, end: clippedEnd });
  }
  return normalize(out).map(toInterval);
}

export interface SchedulingParticipant {
  memberRef: string;
  tzOffsetMinutes: number;
  busy: Interval[];
}

/**
 * Mutual free slots: intersect everyone's working windows, subtract everyone's
 * busy time, then walk the remainder. Slots are spread across distinct days —
 * offering three options on the same afternoon is technically three choices and
 * practically one.
 */
export function proposeSlots(input: {
  participants: SchedulingParticipant[];
  from: string;
  horizonDays: number;
  durationMinutes: number;
  startHour: number;
  endHour: number;
  count: number;
  granularityMinutes?: number;
  includeWeekends?: boolean;
}): ProposalOption[] {
  if (input.participants.length === 0) return [];
  const granularity = input.granularityMinutes ?? 30;

  const windowsPerParticipant = input.participants.map((p) =>
    workingWindows({
      from: input.from,
      days: input.horizonDays,
      tzOffsetMinutes: p.tzOffsetMinutes,
      startHour: input.startHour,
      endHour: input.endHour,
      includeWeekends: input.includeWeekends,
    }),
  );

  let mutual = windowsPerParticipant[0]!;
  for (const w of windowsPerParticipant.slice(1)) {
    mutual = intersectIntervals(mutual, w);
  }

  const allBusy = input.participants.flatMap((p) => p.busy);
  const free = subtractIntervals(mutual, allBusy).map(toSpan);

  const durationMs = input.durationMinutes * MINUTE;
  const step = granularity * MINUTE;
  const chosen: Span[] = [];
  const usedDays = new Set<number>();

  // Pass 1: at most one slot per calendar day, earliest first.
  for (const span of free) {
    // Align the first candidate up to the granularity grid.
    let cursor = Math.ceil(span.start / step) * step;
    while (cursor + durationMs <= span.end) {
      const day = Math.floor(cursor / DAY);
      if (!usedDays.has(day)) {
        chosen.push({ start: cursor, end: cursor + durationMs });
        usedDays.add(day);
        break;
      }
      cursor += step;
    }
    if (chosen.length >= input.count) break;
  }

  // Pass 2: if the horizon is tight, backfill same-day slots rather than
  // offering fewer options than the program asked for.
  if (chosen.length < input.count) {
    for (const span of free) {
      let cursor = Math.ceil(span.start / step) * step;
      while (cursor + durationMs <= span.end && chosen.length < input.count) {
        const candidate = { start: cursor, end: cursor + durationMs };
        if (!chosen.some((c) => c.start === candidate.start)) chosen.push(candidate);
        cursor += step;
      }
      if (chosen.length >= input.count) break;
    }
  }

  return chosen
    .sort((a, b) => a.start - b.start)
    .slice(0, input.count)
    .map((s, index) => ({
      optionId: `opt_${index + 1}`,
      startsAt: iso(s.start),
      endsAt: iso(s.end),
      label: formatSlotLabel(s.start, input.participants),
    }));
}

/**
 * A label showing the time in every participant's own zone. The single highest
 * value line of copy in the whole proposal message.
 */
export function formatSlotLabel(
  startMs: number,
  participants: SchedulingParticipant[],
): string {
  const zones = [...new Set(participants.map((p) => p.tzOffsetMinutes))].sort(
    (a, b) => a - b,
  );
  const parts = zones.map((offset) => {
    const local = new Date(startMs + offset * MINUTE);
    const weekday = local.toLocaleDateString("en-GB", {
      weekday: "short",
      timeZone: "UTC",
    });
    const date = local.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    const time = local.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    return `${weekday} ${date} ${time} (UTC${formatOffset(offset)})`;
  });
  return parts.join(" / ");
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return "+00:00";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

/** When the next session is due, given the pair's agreed frequency. */
export function nextDueAt(
  lastSessionAt: string | null,
  everyDays: number,
  fallbackFrom: string,
): string | null {
  if (everyDays <= 0) return null; // ad-hoc programs have no cadence
  return addDays(lastSessionAt ?? fallbackFrom, everyDays);
}
