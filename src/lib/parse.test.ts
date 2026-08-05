import { describe, expect, it } from 'vitest';
import { parse } from './parse';

const now = new Date('2026-08-02T10:00:00+09:00');

describe('parse', () => {
  it('parses a relative date and time without saving anything', () => {
    expect(parse('明日の15時に歯医者', now)).toMatchObject({
      title: '歯医者',
      due_date: '2026-08-03',
      due_time: '15:00',
    });
  });

  it('parses half-hour times and explicit month/day', () => {
    expect(parse('8月10日 18時半 映画', now)).toMatchObject({
      title: '映画',
      due_date: '2026-08-10',
      due_time: '18:30',
    });
  });

  it('parses the next occurrence of a weekday', () => {
    expect(parse('金曜日までに資料作成', now)).toMatchObject({
      title: 'までに資料作成',
      due_date: '2026-08-07',
    });
  });

  it('rolls a past month/day into the following year', () => {
    expect(parse('8月1日に振り返り', now)).toMatchObject({
      title: '振り返り',
      due_date: '2027-08-01',
    });
  });

  it('validates month/day in the year after rollover', () => {
    expect(
      parse('2月29日にうるう年の予定', new Date('2023-03-01T10:00:00+09:00')),
    ).toMatchObject({
      title: 'うるう年の予定',
      due_date: '2024-02-29',
    });
    expect(
      parse('2月29日に予定', new Date('2024-03-01T10:00:00+09:00')),
    ).toMatchObject({
      title: '2月29日に予定',
      due_date: null,
    });
  });

  it('uses Monday as the start of next week', () => {
    expect(parse('来週の月曜に週次レビュー', now)).toMatchObject({
      title: '週次レビュー',
      due_date: '2026-08-03',
    });
  });

  it('parses daily recurrence with today as the first scheduled date', () => {
    expect(parse('毎日 薬を飲む', now)).toMatchObject({
      title: '薬を飲む',
      due_date: null,
      scheduled_date: '2026-08-02',
      repeat_rule: 'daily',
    });
  });

  it('parses weekly recurrence before ordinary weekday parsing', () => {
    expect(parse('毎週月曜 ゴミ出し', now)).toMatchObject({
      title: 'ゴミ出し',
      due_date: null,
      scheduled_date: '2026-08-03',
      repeat_rule: 'weekly:1',
    });
    expect(parse('毎週 月曜 ゴミ出し', now)).toMatchObject({
      title: 'ゴミ出し',
      due_date: null,
      scheduled_date: '2026-08-03',
      repeat_rule: 'weekly:1',
    });
  });

  it('parses monthly recurrence and chooses its next occurrence', () => {
    expect(parse('毎月15日 家計を確認', now)).toMatchObject({
      title: '家計を確認',
      due_date: null,
      scheduled_date: '2026-08-15',
      repeat_rule: 'monthly:15',
    });
    expect(
      parse('毎月15日 家計を確認', new Date('2026-08-20T10:00:00+09:00')),
    ).toMatchObject({
      due_date: null,
      scheduled_date: '2026-09-15',
      repeat_rule: 'monthly:15',
    });
  });

  it('parses an every-N-days recurrence', () => {
    expect(parse('3日ごとに観葉植物に水やり', now)).toMatchObject({
      title: '観葉植物に水やり',
      due_date: null,
      scheduled_date: '2026-08-02',
      repeat_rule: 'every:3',
    });
  });

  it('does not parse date words embedded in a name', () => {
    expect(parse('明日香さんに連絡', now)).toMatchObject({
      title: '明日香さんに連絡',
      due_date: null,
    });
  });

  it('does not read quantity text like 8月10件 as a month/day date', () => {
    expect(parse('8月10件の面談を設定', now)).toMatchObject({
      title: '8月10件の面談を設定',
      due_date: null,
    });
  });
});
