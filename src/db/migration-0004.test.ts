import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const migrationTable = 'migration_0004_test';

function migration(name: string) {
  const result = env.TEST_MIGRATIONS?.find(
    (candidate) => candidate.name === name,
  );
  if (!result) throw new Error(`Migration is not configured: ${name}`);
  return result;
}

async function applyLegacySchema() {
  // The Workers setup file applies the complete schema before each test. Rebuild
  // the pre-0004 state in the same D1 database so this test exercises the real
  // migration SQL without needing a second database binding.
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS tasks'),
    env.DB.prepare(`DROP TABLE IF EXISTS ${migrationTable}`),
  ]);
  await applyD1Migrations(
    env.DB,
    [
      migration('0001_create_tasks.sql'),
      migration('0003_add_recurring_tasks.sql'),
    ],
    migrationTable,
  );
}

describe('migration 0004', () => {
  it('moves the stopped terminal child of a recurring chain into scheduled fields', async () => {
    await applyLegacySchema();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tasks (id, title, status, due_date, due_time, repeat_child_id, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        1,
        '完了した親',
        'done',
        '2026-08-04',
        '08:00',
        2,
        '2026-08-04 01:00:00',
      ),
      env.DB.prepare(
        `INSERT INTO tasks (id, title, due_date, due_time)
           VALUES (?, ?, ?, ?)`,
      ).bind(2, '繰り返しを停止した最後の回', '2026-08-05', '09:00'),
    ]);
    await applyD1Migrations(
      env.DB,
      [migration('0004_split_task_schedule_dates.sql')],
      migrationTable,
    );

    const migrated = await env.DB.prepare(
      `SELECT due_date IS NULL AS due_date_is_null,
              due_time IS NULL AS due_time_is_null,
              scheduled_date,
              scheduled_time
       FROM tasks WHERE id = ?;`,
    )
      .bind(2)
      .first<{
        due_date_is_null: number;
        due_time_is_null: number;
        scheduled_date: string;
        scheduled_time: string;
      }>();
    expect(migrated).toEqual({
      due_date_is_null: 1,
      due_time_is_null: 1,
      scheduled_date: '2026-08-05',
      scheduled_time: '09:00',
    });

    await env.DB.prepare('INSERT INTO tasks (title) VALUES (?)')
      .bind('連番確認')
      .run();
    const inserted = await env.DB.prepare(
      'SELECT id FROM tasks WHERE title = ?;',
    )
      .bind('連番確認')
      .first<{ id: number }>();
    expect(inserted?.id).toBe(3);

    // D1 supports quick_check for this integrity verification; its Worker
    // binding rejects integrity_check as an unauthorized PRAGMA.
    const integrity = await env.DB.prepare('PRAGMA quick_check').first<{
      quick_check: string;
    }>();
    expect(integrity?.quick_check).toBe('ok');
  });
});
