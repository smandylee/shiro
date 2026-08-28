import { google } from "googleapis";
import { getAuthedClient } from "./client.js";

const DEFAULT_TIMEZONE = "Asia/Hong_Kong";
const OFFSET_RE = /([+-]\d{2}:\d{2}|Z)$/;

function hasOffset(iso: string): boolean {
  return OFFSET_RE.test(iso);
}

function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: DEFAULT_TIMEZONE,
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function listUpcomingEvents(maxResults = 30): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth: getAuthedClient() });

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items ?? [];
  if (events.length === 0) return "예정된 일정이 없어.";

  const lines = events.map((e) => {
    // Google returns times in the calendar's own default zone (Asia/Seoul here),
    // so render them in Hong Kong time — otherwise Shiro quotes an hour that
    // doesn't match the clock the owner is looking at.
    const start = e.start?.dateTime
      ? formatLocal(e.start.dateTime)
      : e.start?.date
        ? `${e.start.date} (종일)`
        : "?";
    // singleEvents expands a series into instances, so deleting by `id` removes
    // just that one. The series id is what removes the whole repeating set.
    const series = e.recurringEventId ? ` [series:${e.recurringEventId}]` : "";
    return `- [id:${e.id}]${series} ${start}: ${e.summary ?? "(제목 없음)"}`;
  });

  return [
    "다가오는 일정 (시각은 홍콩 시간 기준):",
    ...lines,
    "",
    "삭제할 때: 그 회차 하나만 지우려면 id를, 반복 일정 전체를 지우려면 series 값을 delete_calendar_event에 넘긴다.",
  ].join("\n");
}

export type RawEvent = { id: string; summary: string; startIso: string };

export async function listUpcomingEventsRaw(maxResults = 20): Promise<RawEvent[]> {
  const calendar = google.calendar({ version: "v3", auth: getAuthedClient() });

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items ?? [];
  return events
    .filter((e) => e.id && e.start?.dateTime)
    .map((e) => ({
      id: e.id!,
      summary: e.summary ?? "(제목 없음)",
      startIso: e.start!.dateTime!,
    }));
}

export type Repeat = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  count?: number;
  untilIso?: string;
};

// RRULE's UNTIL must be a UTC "basic format" timestamp (20261231T235959Z).
function toRruleUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function buildRrule(repeat: Repeat): string {
  let rule = `RRULE:FREQ=${repeat.freq}`;
  if (repeat.count && repeat.count > 0) rule += `;COUNT=${repeat.count}`;
  else if (repeat.untilIso) rule += `;UNTIL=${toRruleUtc(repeat.untilIso)}`;
  return rule;
}

export async function createEvent(
  summary: string,
  startIso: string,
  endIso: string,
  repeat?: Repeat
): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth: getAuthedClient() });

  // If the model includes an explicit UTC offset, trust it as-is (it correctly
  // encodes the absolute instant). Only fall back to assuming Hong Kong local
  // time when no offset is given, since asking the model to do the arithmetic
  // conversion itself is error-prone.
  const start = hasOffset(startIso)
    ? { dateTime: startIso }
    : { dateTime: startIso, timeZone: DEFAULT_TIMEZONE };
  const end = hasOffset(endIso)
    ? { dateTime: endIso }
    : { dateTime: endIso, timeZone: DEFAULT_TIMEZONE };

  // FREQ=WEEKLY with no BYDAY repeats on the start date's own weekday, which is
  // exactly what a timetable entry wants — no need to spell the day out.
  const recurrence = repeat ? [buildRrule(repeat)] : undefined;

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: { summary, start, end, recurrence },
  });

  const repeatNote = repeat
    ? ` — ${repeat.freq === "WEEKLY" ? "매주" : repeat.freq === "DAILY" ? "매일" : "매달"} 반복${
        repeat.count ? ` ${repeat.count}회` : repeat.untilIso ? ` (${repeat.untilIso.slice(0, 10)}까지)` : ""
      }`
    : "";

  return `일정 추가했어: ${summary} (${startIso} ~ ${endIso})${repeatNote}\n${res.data.htmlLink ?? ""}`;
}

export async function deleteEvent(eventId: string): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth: getAuthedClient() });

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  return `일정 삭제했어 (id: ${eventId})`;
}
