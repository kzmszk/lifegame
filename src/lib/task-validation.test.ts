import { describe, expect, it } from 'vitest';
import {
  fieldsFromBody,
  hasOwn,
  nullableText,
  parseId,
  parseStatus,
  validDate,
  validPriority,
  validTime,
  validateFields,
} from './task-validation';

describe('task validation primitives', () => {
  it('accepts nullable text only when the field is present as text or null', () => {
    const inherited = Object.create({ note: 'inherited' }) as Record<
      string,
      unknown
    >;
    inherited.note = null;

    expect(hasOwn(inherited, 'note')).toBe(true);
    expect(nullableText(inherited, 'note')).toBeNull();
    expect(nullableText({}, 'note')).toBeUndefined();
    expect(nullableText({ note: 42 }, 'note')).toBeUndefined();
  });

  it('validates dates at the format and calendar boundaries', () => {
    expect(validDate(undefined)).toBe(true);
    expect(validDate(null)).toBe(true);
    expect(validDate('0000-01-01')).toBe(true);
    expect(validDate('2000-02-29')).toBe(true);
    expect(validDate('9999-12-31')).toBe(true);
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2026-04-31')).toBe(false);
    expect(validDate('2026-13-01')).toBe(false);
    expect(validDate('2026-1-01')).toBe(false);
    expect(validDate('not-a-date')).toBe(false);
  });

  it('validates times at the lower and upper boundaries', () => {
    expect(validTime(undefined)).toBe(true);
    expect(validTime(null)).toBe(true);
    expect(validTime('00:00')).toBe(true);
    expect(validTime('23:59')).toBe(true);
    expect(validTime('24:00')).toBe(false);
    expect(validTime('12:60')).toBe(false);
    expect(validTime('1:00')).toBe(false);
  });

  it('accepts only integer priorities 0 and 1', () => {
    expect(validPriority(undefined)).toBe(true);
    expect(validPriority(0)).toBe(true);
    expect(validPriority(1)).toBe(true);
    expect(validPriority(-1)).toBe(false);
    expect(validPriority(2)).toBe(false);
    expect(validPriority(0.5)).toBe(false);
    expect(validPriority('1')).toBe(false);
    expect(validPriority(null)).toBe(false);
  });

  it('parses the supported statuses and positive decimal IDs', () => {
    expect(parseStatus('open')).toBe('open');
    expect(parseStatus('done')).toBe('done');
    expect(parseStatus('pending')).toBeUndefined();
    expect(parseStatus(1)).toBeUndefined();

    expect(parseId('1')).toBe(1);
    expect(parseId('0007')).toBe(7);
    expect(parseId('0')).toBeNull();
    expect(parseId('-1')).toBeNull();
    expect(parseId('1.5')).toBeNull();
    expect(parseId('1e3')).toBeNull();
    expect(parseId(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });
});

describe('validateFields', () => {
  it('accepts valid fields, null schedule values, and unknown metadata', () => {
    expect(
      validateFields({
        title: '  買い物  ',
        note: 'メモ',
        tags: '家事',
        due_date: '2026-02-28',
        due_time: '00:00',
        scheduled_date: null,
        scheduled_time: null,
        priority: 1,
        status: 'done',
        repeat_rule: 'daily',
        client_metadata: { source: 'test' },
      }),
    ).toBeNull();
    expect(validateFields({ due_date: null, due_time: null })).toBeNull();
  });

  it.each([
    [
      'completed_at',
      { completed_at: '2026-08-01 00:00:00' },
      'completed_at はクライアントから指定できません',
    ],
    [
      'due_date type',
      { due_date: 20260801 },
      'due_date は YYYY-MM-DD 形式で指定してください',
    ],
    [
      'due_date value',
      { due_date: '2026-02-29' },
      'due_date は YYYY-MM-DD 形式で指定してください',
    ],
    [
      'due_time type',
      { due_time: 900 },
      'due_time は HH:MM 形式で指定してください',
    ],
    [
      'due_time value',
      { due_time: '24:00' },
      'due_time は HH:MM 形式で指定してください',
    ],
    [
      'scheduled_date type',
      { scheduled_date: false },
      'scheduled_date は YYYY-MM-DD 形式で指定してください',
    ],
    [
      'scheduled_date value',
      { scheduled_date: '2026-04-31' },
      'scheduled_date は YYYY-MM-DD 形式で指定してください',
    ],
    [
      'scheduled_time type',
      { scheduled_time: [] },
      'scheduled_time は HH:MM 形式で指定してください',
    ],
    [
      'scheduled_time value',
      { scheduled_time: '12:60' },
      'scheduled_time は HH:MM 形式で指定してください',
    ],
    ['title type', { title: 123 }, 'title は空にできません'],
    ['title empty', { title: '   ' }, 'title は空にできません'],
    ['note type', { note: null }, 'note は文字列で指定してください'],
    ['tags type', { tags: ['work'] }, 'tags は文字列で指定してください'],
    [
      'priority type',
      { priority: '1' },
      'priority は 0 または 1 で指定してください',
    ],
    [
      'priority value',
      { priority: 2 },
      'priority は 0 または 1 で指定してください',
    ],
    [
      'status value',
      { status: 'pending' },
      'status は open または done で指定してください',
    ],
    [
      'repeat_rule value',
      { repeat_rule: 'weekly:9' },
      'repeat_rule は daily、weekly:曜日、monthly:日、every:日数(1〜366)の形式で指定してください',
    ],
  ] as const)('rejects %s', (_name, body, error) => {
    expect(validateFields(body)).toBe(error);
  });

  it('requires a scheduled date when a scheduled time is supplied', () => {
    expect(validateFields({ scheduled_time: '09:00' })).toBeNull();
    expect(
      validateFields({ scheduled_date: null, scheduled_time: '09:00' }),
    ).toBe('scheduled_time を指定するには scheduled_date が必要です');
  });
});

describe('fieldsFromBody', () => {
  it('normalizes supported update fields and ignores unknown fields', () => {
    expect(
      fieldsFromBody({
        title: '  買い物  ',
        note: 'メモ',
        due_date: null,
        due_time: '09:00',
        scheduled_date: '2026-08-07',
        scheduled_time: null,
        priority: 1,
        tags: '家事',
        repeat_rule: 'daily',
        status: 'open',
        client_metadata: 'ignored',
      }),
    ).toEqual({
      title: '買い物',
      note: 'メモ',
      due_date: null,
      due_time: '09:00',
      scheduled_date: '2026-08-07',
      scheduled_time: null,
      priority: 1,
      tags: '家事',
      repeat_rule: 'daily',
      status: 'open',
    });
    expect(fieldsFromBody({ client_metadata: 'ignored' })).toEqual({});
  });

  it('maps null and empty repeat rules to no repeat', () => {
    expect(fieldsFromBody({ repeat_rule: null })).toEqual({
      repeat_rule: null,
    });
    expect(fieldsFromBody({ repeat_rule: '' })).toEqual({ repeat_rule: null });
  });
});
