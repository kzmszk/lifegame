import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function migration(name: string): string {
  return readFileSync(join(process.cwd(), 'migrations', name), 'utf8');
}

function sqlite(databasePath: string, sql: string): string {
  return execFileSync('sqlite3', ['-tabs', databasePath], {
    input: sql,
    encoding: 'utf8',
  });
}

describe('migration 0004', () => {
  it('moves the stopped terminal child of a recurring chain into scheduled fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lifegame-migration-'));
    const databasePath = join(directory, 'tasks.sqlite');
    temporaryDirectories.push(directory);

    sqlite(databasePath, migration('0001_create_tasks.sql'));
    sqlite(databasePath, migration('0003_add_recurring_tasks.sql'));
    sqlite(
      databasePath,
      `INSERT INTO tasks (id, title, status, due_date, due_time, repeat_child_id, completed_at)
       VALUES (1, '完了した親', 'done', '2026-08-04', '08:00', 2, '2026-08-04 01:00:00');
       INSERT INTO tasks (id, title, due_date, due_time)
       VALUES (2, '繰り返しを停止した最後の回', '2026-08-05', '09:00');`,
    );
    sqlite(databasePath, migration('0004_split_task_schedule_dates.sql'));

    expect(
      sqlite(
        databasePath,
        `SELECT due_date IS NULL, due_time IS NULL, scheduled_date, scheduled_time
         FROM tasks WHERE id = 2;`,
      ),
    ).toBe('1\t1\t2026-08-05\t09:00\n');
    expect(
      sqlite(
        databasePath,
        `INSERT INTO tasks (title) VALUES ('連番確認');
         SELECT id FROM tasks WHERE title = '連番確認';
         PRAGMA integrity_check;`,
      ),
    ).toBe('3\nok\n');
  });
});
