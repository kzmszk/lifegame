import { describe, expect, it } from 'vitest';
import {
  HealthSyncValidationError,
  MAX_SYNC_RECORDS,
  normalizeSyncPayload,
} from './health-sync';

function weight(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'weight',
    external_id: 'hc-weight-1',
    occurred_at: '2026-08-10T07:12:00+09:00',
    weight_kg: 68.4,
    ...overrides,
  };
}

function exercise(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'exercise',
    external_id: 'hc-exercise-1',
    occurred_at: '2026-08-10T19:00:00+09:00',
    activity: 'ランニング',
    duration_minutes: 32,
    ...overrides,
  };
}

function rejects(body: unknown): string {
  try {
    normalizeSyncPayload(body);
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(HealthSyncValidationError);
    return (thrown as Error).message;
  }
  throw new Error('payload was accepted');
}

describe('normalizeSyncPayload', () => {
  it('normalizes a weight measurement and derives the local date', () => {
    expect(normalizeSyncPayload([weight()])).toEqual([
      {
        kind: 'weight',
        external_id: 'hc-weight-1',
        occurred_on: '2026-08-10',
        occurred_at: '2026-08-10T07:12:00+09:00',
        weight_kg: 68.4,
        activity: null,
        duration_minutes: null,
      },
    ]);
  });

  it('normalizes an exercise session and trims the activity', () => {
    expect(
      normalizeSyncPayload([exercise({ activity: '  ランニング ' })]),
    ).toEqual([
      {
        kind: 'exercise',
        external_id: 'hc-exercise-1',
        occurred_on: '2026-08-10',
        occurred_at: '2026-08-10T19:00:00+09:00',
        weight_kg: null,
        activity: 'ランニング',
        duration_minutes: 32,
      },
    ]);
  });

  it('treats an omitted duration as none', () => {
    const [record] = normalizeSyncPayload([
      { ...exercise(), duration_minutes: undefined },
    ]);
    expect(record?.duration_minutes).toBeNull();
  });

  it('accepts an empty payload', () => {
    expect(normalizeSyncPayload([])).toEqual([]);
  });

  // The date the entry is listed under is the local one, so the same instant in a
  // different offset belongs to a different day. Deriving it from the offset the
  // device sent is what keeps a 07:12 JST measurement off the previous day.
  it('takes the local date from the offset, not from UTC', () => {
    const [record] = normalizeSyncPayload([
      weight({ occurred_at: '2026-08-10T07:12:00+09:00' }),
    ]);
    expect(record?.occurred_on).toBe('2026-08-10');

    const [utc] = normalizeSyncPayload([
      weight({ occurred_at: '2026-08-09T22:12:00Z' }),
    ]);
    expect(utc?.occurred_on).toBe('2026-08-09');
  });

  it('requires an offset on occurred_at', () => {
    expect(rejects([weight({ occurred_at: '2026-08-10T07:12:00' })])).toContain(
      'オフセット',
    );
  });

  it('rejects an occurred_at that is not a real date or time', () => {
    expect(
      rejects([weight({ occurred_at: '2026-02-30T07:12:00+09:00' })]),
    ).toContain('日付');
    expect(
      rejects([weight({ occurred_at: '2026-08-10T25:12:00+09:00' })]),
    ).toContain('時刻');
  });

  it('rejects a record with no external_id', () => {
    expect(rejects([weight({ external_id: '   ' })])).toContain('external_id');
  });

  it('rejects a duplicated external_id in one payload', () => {
    expect(rejects([weight(), weight()])).toContain('重複');
  });

  it('rejects sleep by name rather than dropping it', () => {
    expect(rejects([{ ...weight(), kind: 'sleep' }])).toContain('kind');
  });

  it('rejects mixed shapes', () => {
    expect(rejects([weight({ activity: 'ランニング' })])).toContain('運動実績');
    expect(rejects([exercise({ weight_kg: 68 })])).toContain('体重測定');
  });

  it('rejects an out-of-range weight and duration', () => {
    expect(rejects([weight({ weight_kg: 0 })])).toContain('weight_kg');
    expect(rejects([exercise({ duration_minutes: 1441 })])).toContain(
      'duration_minutes',
    );
  });

  it('rejects a body that is not an array', () => {
    expect(rejects({ records: [weight()] })).toContain('配列');
  });

  it('rejects more records than one request may carry', () => {
    const many = Array.from({ length: MAX_SYNC_RECORDS + 1 }, (_, index) =>
      weight({ external_id: `hc-${index}` }),
    );
    expect(rejects(many)).toContain(String(MAX_SYNC_RECORDS));
  });
});
