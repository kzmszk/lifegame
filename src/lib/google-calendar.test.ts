import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCalendarEvent,
  GoogleCalendarError,
  listCalendarEvents,
} from './google-calendar';
import { shiftTokyoWallClock, tokyoDayRangeIso, tokyoTimeOfDay } from './time';
import type { Env } from '../env';

function env(overrides: Record<string, unknown> = {}): Env {
  const store = new Map<string, string>();
  return {
    OAUTH_KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    },
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    ...overrides,
  } as unknown as Env;
}

/** Answer the token endpoint, then hand each API call to the supplied handler. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return Response.json({ access_token: 'access-token', expires_in: 3599 });
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tokyoDayRangeIso', () => {
  it('covers exactly one Tokyo day', () => {
    expect(tokyoDayRangeIso('2026-08-04')).toEqual({
      timeMin: '2026-08-04T00:00:00+09:00',
      timeMax: '2026-08-05T00:00:00+09:00',
    });
  });

  it('rolls over the year end', () => {
    expect(tokyoDayRangeIso('2026-12-31').timeMax).toBe(
      '2027-01-01T00:00:00+09:00',
    );
  });

  it('rolls over a leap day', () => {
    expect(tokyoDayRangeIso('2028-02-28').timeMax).toBe(
      '2028-02-29T00:00:00+09:00',
    );
  });
});

describe('tokyoTimeOfDay', () => {
  it('reads a Tokyo-offset instant', () => {
    expect(tokyoTimeOfDay('2026-08-05T08:00:00+09:00')).toBe('08:00');
  });

  it('converts from another offset', () => {
    expect(tokyoTimeOfDay('2026-08-04T15:30:00Z')).toBe('00:30');
  });

  it('renders midnight as 00:00 rather than 24:00', () => {
    expect(tokyoTimeOfDay('2026-08-05T00:00:00+09:00')).toBe('00:00');
  });
});

describe('shiftTokyoWallClock', () => {
  it('adds an hour within the day', () => {
    expect(shiftTokyoWallClock('2026-08-04', '09:15', 60)).toEqual({
      date: '2026-08-04',
      time: '10:15',
    });
  });

  it('rolls the date over at midnight', () => {
    expect(shiftTokyoWallClock('2026-12-31', '23:30', 60)).toEqual({
      date: '2027-01-01',
      time: '00:30',
    });
  });
});

describe('listCalendarEvents', () => {
  it('expands recurring events and orders them by start time', async () => {
    const { calls } = stubFetch(() => Response.json({ items: [] }));
    await listCalendarEvents(env(), '2026-08-07');

    const query = new URL(calls[0].url).searchParams;
    // Without these the API returns recurring parents, so weekly events would
    // silently vanish from the day they actually fall on.
    expect(query.get('singleEvents')).toBe('true');
    expect(query.get('orderBy')).toBe('startTime');
    expect(query.get('timeMin')).toBe('2026-08-07T00:00:00+09:00');
    expect(query.get('timeMax')).toBe('2026-08-08T00:00:00+09:00');
  });

  it('flattens a timed event', async () => {
    stubFetch(() =>
      Response.json({
        items: [
          {
            id: 'event-1',
            summary: 'ピアノ',
            location: '教室',
            description: 'メモ',
            htmlLink: 'https://example.test/event',
            start: { dateTime: '2026-08-07T18:30:00+09:00' },
            end: { dateTime: '2026-08-07T19:00:00+09:00' },
          },
        ],
      }),
    );

    const [event] = await listCalendarEvents(env(), '2026-08-07');
    expect(event).toMatchObject({
      id: 'event-1',
      title: 'ピアノ',
      all_day: false,
      start_time: '18:30',
      end_time: '19:00',
      location: '教室',
      note: 'メモ',
    });
  });

  it('marks an all-day event and leaves its times null', async () => {
    stubFetch(() =>
      Response.json({
        items: [
          {
            id: 'holiday',
            summary: '山の日',
            start: { date: '2026-08-11' },
            end: { date: '2026-08-12' },
          },
        ],
      }),
    );

    const [event] = await listCalendarEvents(env(), '2026-08-11');
    expect(event).toMatchObject({
      all_day: true,
      start_time: null,
      end_time: null,
    });
  });

  it('drops cancelled and declined events', async () => {
    stubFetch(() =>
      Response.json({
        items: [
          {
            id: 'cancelled',
            status: 'cancelled',
            summary: '取消',
            start: { dateTime: '2026-08-07T10:00:00+09:00' },
            end: { dateTime: '2026-08-07T11:00:00+09:00' },
          },
          {
            id: 'declined',
            summary: '欠席',
            attendees: [{ self: true, responseStatus: 'declined' }],
            start: { dateTime: '2026-08-07T12:00:00+09:00' },
            end: { dateTime: '2026-08-07T13:00:00+09:00' },
          },
          {
            id: 'kept',
            summary: '出席',
            attendees: [{ self: true, responseStatus: 'accepted' }],
            start: { dateTime: '2026-08-07T14:00:00+09:00' },
            end: { dateTime: '2026-08-07T15:00:00+09:00' },
          },
        ],
      }),
    );

    const events = await listCalendarEvents(env(), '2026-08-07');
    expect(events.map((event) => event.id)).toEqual(['kept']);
  });

  it('follows nextPageToken so a busy day is not silently truncated', async () => {
    const { calls } = stubFetch((url) => {
      const token = new URL(url).searchParams.get('pageToken');
      if (token === null) {
        return Response.json({
          nextPageToken: 'page-2',
          items: [
            {
              id: 'first',
              summary: '1件目',
              start: { dateTime: '2026-08-07T09:00:00+09:00' },
              end: { dateTime: '2026-08-07T10:00:00+09:00' },
            },
          ],
        });
      }
      return Response.json({
        items: [
          {
            id: 'second',
            summary: '2件目',
            start: { dateTime: '2026-08-07T11:00:00+09:00' },
            end: { dateTime: '2026-08-07T12:00:00+09:00' },
          },
        ],
      });
    });

    const events = await listCalendarEvents(env(), '2026-08-07');
    expect(events.map((event) => event.id)).toEqual(['first', 'second']);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get('pageToken')).toBe('page-2');
  });

  it('stops paging at the cap instead of looping forever', async () => {
    // A response that always hands back a token would otherwise never terminate.
    const { calls } = stubFetch(() =>
      Response.json({ nextPageToken: 'always-more', items: [] }),
    );
    await expect(listCalendarEvents(env(), '2026-08-07')).resolves.toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('reuses the cached access token across calls', async () => {
    const { fetchMock } = stubFetch(() => Response.json({ items: [] }));
    const shared = env();
    await listCalendarEvents(shared, '2026-08-07');
    await listCalendarEvents(shared, '2026-08-08');

    const tokenCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('https://oauth2.googleapis.com/token'),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('refreshes once when a cached token has been revoked', async () => {
    let apiCalls = 0;
    const { fetchMock } = stubFetch(() => {
      apiCalls += 1;
      return apiCalls === 1
        ? new Response('', { status: 401 })
        : Response.json({ items: [] });
    });

    await expect(listCalendarEvents(env(), '2026-08-07')).resolves.toEqual([]);
    const tokenCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('https://oauth2.googleapis.com/token'),
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it('gives up after a second 401 rather than looping', async () => {
    stubFetch(() => new Response('', { status: 401 }));
    await expect(listCalendarEvents(env(), '2026-08-07')).rejects.toMatchObject(
      { kind: 'auth' },
    );
  });

  it('reports missing credentials as a config error', async () => {
    stubFetch(() => Response.json({ items: [] }));
    await expect(
      listCalendarEvents(
        env({ GOOGLE_REFRESH_TOKEN: undefined }),
        '2026-08-07',
      ),
    ).rejects.toBeInstanceOf(GoogleCalendarError);
  });

  it('reports an upstream failure separately from an auth failure', async () => {
    stubFetch(() => new Response('', { status: 503 }));
    await expect(listCalendarEvents(env(), '2026-08-07')).rejects.toMatchObject(
      { kind: 'upstream' },
    );
  });
});

describe('createCalendarEvent', () => {
  it('defaults to a one-hour event in Tokyo time', async () => {
    const { calls } = stubFetch(() =>
      Response.json({
        id: 'created',
        summary: '歯医者',
        start: { dateTime: '2026-08-05T15:00:00+09:00' },
        end: { dateTime: '2026-08-05T16:00:00+09:00' },
      }),
    );

    await createCalendarEvent(env(), {
      title: '歯医者',
      date: '2026-08-05',
      start_time: '15:00',
    });

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.start).toEqual({
      dateTime: '2026-08-05T15:00:00',
      timeZone: 'Asia/Tokyo',
    });
    expect(sent.end).toEqual({
      dateTime: '2026-08-05T16:00:00',
      timeZone: 'Asia/Tokyo',
    });
  });

  it('honours an explicit end time', async () => {
    const { calls } = stubFetch(() =>
      Response.json({
        id: 'created',
        summary: '会議',
        start: { dateTime: '2026-08-05T15:00:00+09:00' },
        end: { dateTime: '2026-08-05T15:30:00+09:00' },
      }),
    );

    await createCalendarEvent(env(), {
      title: '会議',
      date: '2026-08-05',
      start_time: '15:00',
      end_time: '15:30',
    });

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.end.dateTime).toBe('2026-08-05T15:30:00');
  });

  it('carries a default end past midnight into the next day', async () => {
    const { calls } = stubFetch(() =>
      Response.json({
        id: 'created',
        summary: '夜更かし',
        start: { dateTime: '2026-08-05T23:30:00+09:00' },
        end: { dateTime: '2026-08-06T00:30:00+09:00' },
      }),
    );

    await createCalendarEvent(env(), {
      title: '夜更かし',
      date: '2026-08-05',
      start_time: '23:30',
    });

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.end.dateTime).toBe('2026-08-06T00:30:00');
  });
});
