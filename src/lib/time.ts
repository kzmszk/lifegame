const TOKYO_TIME_ZONE = 'Asia/Tokyo';

function tokyoParts(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function formatSqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function tokyoToday(now: Date = new Date()): string {
  const { year, month, day } = tokyoParts(now);
  return formatDate(year, month, day);
}

/**
 * Build a UTC Date from Tokyo wall-clock parts. Date.UTC() maps years 0-99 into
 * the 1900s, so the year is reapplied afterwards.
 */
function utcFromParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  date.setUTCFullYear(year);
  return date;
}

/**
 * The RFC 3339 bounds of a Tokyo calendar day, for Google Calendar's
 * `timeMin`/`timeMax`. The upper bound is exclusive, as that API expects.
 */
export function tokyoDayRangeIso(date: string): {
  timeMin: string;
  timeMax: string;
} {
  const [year, month, day] = date.split('-').map(Number);
  // Asia/Tokyo has no DST, so a fixed 24 hours always lands on the next midnight.
  const next = new Date(
    utcFromParts(year, month, day).getTime() + 24 * 60 * 60 * 1000,
  );
  const nextDate = formatDate(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
  return {
    timeMin: `${date}T00:00:00+09:00`,
    timeMax: `${nextDate}T00:00:00+09:00`,
  };
}

/** Render an instant as Tokyo wall-clock 'HH:MM'. */
export function tokyoTimeOfDay(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOKYO_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    // h23 rather than hour12:false, which renders midnight as 24:00 on some runtimes.
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.hour}:${values.minute}`;
}

/**
 * Move a Tokyo wall-clock date/time by whole minutes, rolling the date over when
 * the shift crosses midnight.
 */
export function shiftTokyoWallClock(
  date: string,
  time: string,
  minutes: number,
): { date: string; time: string } {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const shifted = new Date(
    utcFromParts(year, month, day, hour, minute).getTime() + minutes * 60_000,
  );
  return {
    date: formatDate(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
    ),
    time: `${shifted.getUTCHours().toString().padStart(2, '0')}:${shifted
      .getUTCMinutes()
      .toString()
      .padStart(2, '0')}`,
  };
}

/** Calculate Tokyo's day boundary, represented in SQLite's UTC datetime format. */
export function tokyoDayBounds(now: Date = new Date()): {
  today: string;
  startUtc: string;
  nextStartUtc: string;
} {
  const { year, month, day } = tokyoParts(now);
  // Asia/Tokyo is UTC+09:00 and has no DST transitions.
  const start = new Date(Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000);
  const nextStart = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    today: formatDate(year, month, day),
    startUtc: formatSqlUtc(start),
    nextStartUtc: formatSqlUtc(nextStart),
  };
}
