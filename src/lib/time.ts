const TOKYO_TIME_ZONE = 'Asia/Tokyo';

function tokyoParts(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
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
  return { today: formatDate(year, month, day), startUtc: formatSqlUtc(start), nextStartUtc: formatSqlUtc(nextStart) };
}
