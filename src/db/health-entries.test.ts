import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createHealthEntry,
  deleteHealthEntry,
  HealthEntryValidationError,
  listHealthEntries,
  updateHealthEntry,
} from './health-entries';

describe('health entries on real D1', () => {
  it('creates and lists a weight measurement', async () => {
    const created = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
      note: '朝',
    });

    expect(created).toMatchObject({
      id: expect.any(Number),
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68.4,
      note: '朝',
    });

    const page = await listHealthEntries(env.DB, { limit: 50, offset: 0 });
    expect(page).toMatchObject({ truncated: false, next_offset: null });
    expect(page.entries).toEqual([created]);
  });

  it('creates an exercise session with an optional duration', async () => {
    const created = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: 'ランニング',
      duration_minutes: 30,
      note: '公園',
    });

    expect(created).toMatchObject({
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: 'ランニング',
      duration_minutes: 30,
      note: '公園',
    });
    expect('weight_kg' in created).toBe(false);

    const withoutDuration = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-06',
      activity: 'ヨガ',
    });
    expect(withoutDuration).toMatchObject({
      kind: 'exercise',
      duration_minutes: null,
    });
  });

  it('orders same-day entries by descending id after occurrence date', async () => {
    const older = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: '散歩',
    });
    const newer = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 68,
    });
    await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-08',
      activity: 'ストレッチ',
    });

    const page = await listHealthEntries(env.DB, { limit: 50 });
    expect(page.entries.map((entry) => entry.id)).toEqual([
      3,
      newer.id,
      older.id,
    ]);
  });

  it('supports inclusive date filters and stable limit-offset pagination', async () => {
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-05',
      weight_kg: 65,
    });
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-06',
      weight_kg: 66,
    });
    await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-07',
      weight_kg: 67,
    });

    const first = await listHealthEntries(env.DB, {
      from: '2026-08-05',
      to: '2026-08-07',
      limit: 2,
      offset: 0,
    });
    const second = await listHealthEntries(env.DB, {
      from: '2026-08-05',
      to: '2026-08-07',
      limit: 2,
      offset: first.next_offset ?? 0,
    });

    expect(first.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-07',
      '2026-08-06',
    ]);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(2);
    expect(second.entries.map((entry) => entry.occurred_on)).toEqual([
      '2026-08-05',
    ]);
    expect(second.truncated).toBe(false);
    expect(second.next_offset).toBeNull();
  });

  it('corrects an entry without changing its kind', async () => {
    const weight = await createHealthEntry(env.DB, {
      kind: 'weight',
      occurred_on: '2026-08-01',
      weight_kg: 70,
    });

    const corrected = await updateHealthEntry(env.DB, weight.id, {
      kind: 'weight',
      occurred_on: '2026-08-02',
      weight_kg: 69.5,
      note: '訂正',
    });

    expect(corrected).toMatchObject({
      id: weight.id,
      kind: 'weight',
      occurred_on: '2026-08-02',
      weight_kg: 69.5,
      note: '訂正',
    });
    await expect(
      updateHealthEntry(env.DB, weight.id, {
        kind: 'exercise',
        activity: '誤入力',
      }),
    ).rejects.toThrow(HealthEntryValidationError);
  });

  it('deletes one entry and reports missing ids', async () => {
    const entry = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: '筋トレ',
    });

    expect(await deleteHealthEntry(env.DB, entry.id)).toBe(true);
    expect(await deleteHealthEntry(env.DB, entry.id)).toBe(false);
    expect((await listHealthEntries(env.DB)).entries).toEqual([]);
  });

  it('corrects exercise-specific fields and can clear its duration', async () => {
    const exercise = await createHealthEntry(env.DB, {
      kind: 'exercise',
      occurred_on: '2026-08-07',
      activity: 'サイクリング',
      duration_minutes: 45,
    });

    const corrected = await updateHealthEntry(env.DB, exercise.id, {
      kind: 'exercise',
      activity: '水泳',
      duration_minutes: null,
    });

    expect(corrected).toMatchObject({
      kind: 'exercise',
      activity: '水泳',
      duration_minutes: null,
    });
  });

  it('rejects invalid inputs before they reach D1', async () => {
    await expect(
      createHealthEntry(env.DB, {
        kind: 'weight',
        occurred_on: '2026-02-29',
        weight_kg: 68,
      }),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      createHealthEntry(env.DB, {
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: Number.NaN,
      }),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      createHealthEntry(env.DB, {
        kind: 'exercise',
        occurred_on: '2026-08-07',
        activity: '散歩',
        duration_minutes: 0,
      }),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      createHealthEntry(env.DB, {
        kind: 'weight',
        occurred_on: '2026-08-07',
        weight_kg: 68,
        activity: '混在',
      } as never),
    ).rejects.toThrow(HealthEntryValidationError);
    await expect(
      listHealthEntries(env.DB, {
        from: '2026-08-08',
        to: '2026-08-07',
      }),
    ).rejects.toThrow(HealthEntryValidationError);
  });

  it('enforces the discriminated combinations at the D1 boundary', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, weight_kg, activity)
         VALUES ('weight', '2026-08-07', 68, '混在')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, activity, duration_minutes)
         VALUES ('exercise', '2026-08-07', '散歩', 1441)`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO health_entries (kind, occurred_on, activity)
         VALUES ('exercise', '2026-08-07', '   ')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
