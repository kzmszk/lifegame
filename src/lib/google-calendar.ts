import type { CalendarEvent, CalendarEventCreateInput } from '../shared/types';
import type { Env } from '../env';
import { shiftTokyoWallClock, tokyoDayRangeIso, tokyoTimeOfDay } from './time';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
// 'primary' is the authenticated account's default calendar, which is the only
// one still in use (DESIGN.md section 12). Using the alias keeps the owner's
// address out of the source.
const CALENDAR_ID = 'primary';
// Subscribed, read-only, and auto-populated. Holidays are not appointments, so
// they stay out of the today view and surface only in the daily summary.
const HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const TIME_ZONE = 'Asia/Tokyo';
const ACCESS_TOKEN_CACHE_KEY = 'google:access_token';
// Google's access tokens last an hour. Retiring the cached copy a minute early
// keeps a request from picking up a token that expires while it is in flight.
const EXPIRY_MARGIN_SECONDS = 60;
// KV rejects a TTL under 60 seconds, so a token shorter than that is simply not cached.
const MIN_CACHE_TTL_SECONDS = 60;
const MAX_EVENTS_PER_PAGE = 250;
// A single Tokyo day past this many pages is not a real personal calendar. The
// cap exists so a pathological response cannot spin; hitting it is logged rather
// than passed off as a complete list.
const MAX_EVENT_PAGES = 4;
const DEFAULT_DURATION_MINUTES = 60;

export type CalendarErrorKind = 'config' | 'auth' | 'upstream';

export class GoogleCalendarError extends Error {
  readonly kind: CalendarErrorKind;

  constructor(kind: CalendarErrorKind, message: string) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.kind = kind;
  }
}

interface GoogleEventTime {
  date?: string;
  dateTime?: string;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exchange the stored refresh token for an access token, caching it in KV. */
async function fetchAccessToken(env: Env): Promise<string> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      refresh_token: env.GOOGLE_REFRESH_TOKEN as string,
      grant_type: 'refresh_token',
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !isRecord(body) ||
    typeof body.access_token !== 'string'
  ) {
    // The usual cause is an expired refresh token, and the usual cause of that is
    // an OAuth consent screen left in "Testing" (docs/GCAL_SETUP.md).
    throw new GoogleCalendarError(
      'auth',
      'Google の認証に失敗しました。refresh token が失効している可能性があります',
    );
  }

  const expiresIn =
    typeof body.expires_in === 'number' ? Math.floor(body.expires_in) : 0;
  const ttl = expiresIn - EXPIRY_MARGIN_SECONDS;
  if (ttl >= MIN_CACHE_TTL_SECONDS) {
    await env.OAUTH_KV.put(ACCESS_TOKEN_CACHE_KEY, body.access_token, {
      expirationTtl: ttl,
    });
  }
  return body.access_token;
}

async function accessToken(env: Env): Promise<string> {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN
  ) {
    throw new GoogleCalendarError(
      'config',
      'Google Calendar の認証情報が設定されていません',
    );
  }
  const cached = await env.OAUTH_KV.get(ACCESS_TOKEN_CACHE_KEY);
  return cached ?? (await fetchAccessToken(env));
}

async function callGoogle(
  env: Env,
  url: string,
  init: RequestInit,
  retryOnUnauthorized = true,
): Promise<Record<string, unknown>> {
  const token = await accessToken(env);
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });

  if (response.status === 401 && retryOnUnauthorized) {
    // A revoked or rotated token can outlive its cache entry, so one forced
    // refresh separates "stale cache" from "credentials are actually broken".
    await env.OAUTH_KV.delete(ACCESS_TOKEN_CACHE_KEY);
    return callGoogle(env, url, init, false);
  }
  if (!response.ok) {
    throw new GoogleCalendarError(
      response.status === 401 ? 'auth' : 'upstream',
      `Google Calendar API がエラーを返しました (${response.status})`,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) {
    throw new GoogleCalendarError(
      'upstream',
      'Google Calendar API の応答を解釈できませんでした',
    );
  }
  return body;
}

/**
 * Flatten one event against the day it was requested for. The API returns
 * anything that *overlaps* the range, so an event can begin before the day or
 * run past it; `start_time` alone would then read as "starts tonight" for
 * something already under way.
 */
function toCalendarEvent(
  event: GoogleEvent,
  range: { timeMin: string; timeMax: string },
): CalendarEvent | null {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!event.id || !start || !end) return null;
  // All-day events carry `date` instead of `dateTime`, and have no wall-clock time.
  const allDay = event.start?.dateTime === undefined;
  // All-day bounds are plain dates compared as strings, and Google's end date is
  // exclusive, so it lines up with the exclusive timeMax.
  const startedEarlier = allDay
    ? start < range.timeMin.slice(0, 10)
    : Date.parse(start) < Date.parse(range.timeMin);
  const endsLater = allDay
    ? end > range.timeMax.slice(0, 10)
    : Date.parse(end) > Date.parse(range.timeMax);

  return {
    id: event.id,
    title: event.summary?.trim() || '(タイトルなし)',
    all_day: allDay,
    start,
    end,
    start_time: allDay ? null : tokyoTimeOfDay(start),
    end_time: allDay ? null : tokyoTimeOfDay(end),
    started_earlier: startedEarlier,
    ends_later: endsLater,
    location: event.location ?? null,
    note: event.description ?? '',
    html_link: event.htmlLink ?? '',
  };
}

function isDeclined(event: GoogleEvent): boolean {
  return (
    event.attendees?.some(
      (attendee) => attendee.self && attendee.responseStatus === 'declined',
    ) ?? false
  );
}

async function listEventsOn(
  env: Env,
  calendarId: string,
  date: string,
): Promise<CalendarEvent[]> {
  const { timeMin, timeMax } = tokyoDayRangeIso(date);
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  // maxResults is a page size, not a total. Stopping at the first page would
  // drop the rest of the day's events without any sign that it had happened.
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const url = new URL(
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.search = new URLSearchParams({
      timeMin,
      timeMax,
      // Without singleEvents the API returns the recurring parent rather than the
      // occurrences, so weekly events never show up on the day they fall on.
      singleEvents: 'true',
      orderBy: 'startTime',
      timeZone: TIME_ZONE,
      maxResults: String(MAX_EVENTS_PER_PAGE),
      ...(pageToken ? { pageToken } : {}),
    }).toString();

    const body = await callGoogle(env, url.toString(), { method: 'GET' });
    const items: GoogleEvent[] = Array.isArray(body.items)
      ? (body.items as GoogleEvent[])
      : [];
    events.push(
      ...items
        .filter((event) => event.status !== 'cancelled' && !isDeclined(event))
        .map((event) => toCalendarEvent(event, { timeMin, timeMax }))
        .filter((event): event is CalendarEvent => event !== null),
    );

    pageToken =
      typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    if (!pageToken) return events;
  }

  console.warn(`${date} の予定が多く、取得を打ち切りました (${calendarId})`);
  return events;
}

/** Fetch one Tokyo day's events from the primary calendar. */
export function listCalendarEvents(
  env: Env,
  date: string,
): Promise<CalendarEvent[]> {
  return listEventsOn(env, CALENDAR_ID, date);
}

/** Names of the Japanese holidays falling on the given Tokyo day, if any. */
export async function listHolidays(env: Env, date: string): Promise<string[]> {
  const events = await listEventsOn(env, HOLIDAY_CALENDAR_ID, date);
  return events.map((event) => event.title);
}

/** Create a timed event on the primary calendar. */
export async function createCalendarEvent(
  env: Env,
  input: CalendarEventCreateInput,
): Promise<CalendarEvent> {
  // An end at or before the start belongs to the next day; Google rejects an end
  // that precedes the start, and 23:30-00:30 is a perfectly ordinary evening.
  const end = !input.end_time
    ? shiftTokyoWallClock(
        input.date,
        input.start_time,
        DEFAULT_DURATION_MINUTES,
      )
    : {
        date:
          input.end_time <= input.start_time
            ? shiftTokyoWallClock(input.date, '00:00', 24 * 60).date
            : input.date,
        time: input.end_time,
      };

  const url = `${API_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
  const body = await callGoogle(env, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: input.title,
      description: input.note ?? '',
      // A naive local time plus an explicit timeZone; no offset arithmetic here.
      start: {
        dateTime: `${input.date}T${input.start_time}:00`,
        timeZone: TIME_ZONE,
      },
      end: { dateTime: `${end.date}T${end.time}:00`, timeZone: TIME_ZONE },
    }),
  });

  // Framed against the day it was created for, so an overnight event comes back
  // flagged the same way the listing would flag it.
  const created = toCalendarEvent(
    body as GoogleEvent,
    tokyoDayRangeIso(input.date),
  );
  if (!created) {
    throw new GoogleCalendarError(
      'upstream',
      '作成した予定を解釈できませんでした',
    );
  }
  return created;
}
