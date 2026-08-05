import type { TaskDraft } from '../shared/types';

const TIME_ZONE = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

interface TokyoDateParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function tokyoDateParts(now: Date): TokyoDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    values.weekday,
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function addDays(parts: TokyoDateParts, amount: number): string {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + amount),
  );
  return formatDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function dateFromMonthDay(
  parts: TokyoDateParts,
  month: number,
  day: number,
): string | null {
  const targetYear =
    month < parts.month || (month === parts.month && day < parts.day)
      ? parts.year + 1
      : parts.year;
  // Start from a leap year so February 29 can be evaluated after the target year is known.
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  candidate.setUTCFullYear(targetYear);
  if (candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day)
    return null;

  return formatDate(
    candidate.getUTCFullYear(),
    candidate.getUTCMonth() + 1,
    candidate.getUTCDate(),
  );
}

function weekdayDate(
  parts: TokyoDateParts,
  weekday: number,
  nextWeek: boolean,
): string {
  if (nextWeek) {
    // ISO-style weeks start on Monday. Sunday (0) is therefore six days into the current week.
    const daysSinceMonday = (parts.weekday + 6) % 7;
    const daysUntilNextWeekMonday = 7 - daysSinceMonday;
    const offsetInNextWeek = (weekday + 6) % 7;
    return addDays(parts, daysUntilNextWeekMonday + offsetInNextWeek);
  }
  return addDays(parts, (weekday - parts.weekday + 7) % 7);
}

function cleanTitle(value: string): string {
  return value
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s、,。:：]+/, '')
    .replace(/^(?:の|に|へ|を|は|が|と)\s*/, '')
    .replace(/\s*(?:に|で)$/, '')
    .replace(/[\s、,。:：]+$/, '')
    .trim();
}

function parseTime(value: string): { time: string | null; title: string } {
  const match = value.match(/(午前|午後)?\s*(\d{1,2})時(半|(?:\d{1,2})分)?/);
  if (!match) return { time: null, title: value };

  let hour = Number(match[2]);
  const minute =
    match[3] === '半' ? 30 : match[3] ? Number(match[3].replace('分', '')) : 0;
  if (hour > 23 || minute > 59) return { time: null, title: value };
  if (match[1] === '午後' && hour < 12) hour += 12;
  if (match[1] === '午前' && hour === 12) hour = 0;

  return {
    time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
    title: value.replace(match[0], ''),
  };
}

/**
 * Convert a Japanese quick-add sentence into a stable, UI-editable draft.
 * The optional `now` argument exists to make the rule-based parser deterministic in tests.
 */
export function parse(text: string, now: Date = new Date()): TaskDraft {
  const original = text.trim();
  let remaining = original;
  const today = tokyoDateParts(now);
  let dueDate: string | null = null;

  const nextWeekdayMatch = remaining.match(
    /来週(?:の)?([月火水木金土日])(?:曜日|曜)/,
  );
  if (nextWeekdayMatch) {
    dueDate = weekdayDate(
      today,
      WEEKDAYS.indexOf(nextWeekdayMatch[1] as (typeof WEEKDAYS)[number]),
      true,
    );
    remaining = remaining.replace(nextWeekdayMatch[0], '');
  } else {
    // Do not treat the date words inside names such as "明日香" as date phrases.
    const relativeMatch = remaining.match(
      /(明後日|明日|今日)(?![\p{Script=Han}])/u,
    );
    if (relativeMatch) {
      const offset =
        relativeMatch[0] === '明後日' ? 2 : relativeMatch[0] === '明日' ? 1 : 0;
      dueDate = addDays(today, offset);
      remaining = remaining.replace(
        new RegExp(`${relativeMatch[0]}(?:の)?`),
        '',
      );
    } else {
      // Require the 日 suffix so quantity text such as "8月10件" is not read as a date.
      const monthDayMatch = remaining.match(/(\d{1,2})月\s*(\d{1,2})日/);
      if (monthDayMatch) {
        const parsedDate = dateFromMonthDay(
          today,
          Number(monthDayMatch[1]),
          Number(monthDayMatch[2]),
        );
        if (parsedDate) {
          dueDate = parsedDate;
          remaining = remaining.replace(monthDayMatch[0], '');
        }
      }

      if (!dueDate) {
        const weekdayMatch = remaining.match(/([月火水木金土日])(?:曜日|曜)/);
        if (weekdayMatch) {
          dueDate = weekdayDate(
            today,
            WEEKDAYS.indexOf(weekdayMatch[1] as (typeof WEEKDAYS)[number]),
            false,
          );
          remaining = remaining.replace(weekdayMatch[0], '');
        }
      }

      if (!dueDate && remaining.includes('来週')) {
        dueDate = addDays(today, 7);
        remaining = remaining.replace(/来週(?:の)?/, '');
      }
    }
  }

  const parsedTime = parseTime(remaining);
  remaining = parsedTime.title;
  const title =
    cleanTitle(remaining) || (original ? '新しいタスク' : '新しいタスク');

  return {
    title,
    note: '',
    due_date: dueDate,
    due_time: parsedTime.time,
    priority: 0,
    tags: '',
    repeat_rule: null,
  };
}
