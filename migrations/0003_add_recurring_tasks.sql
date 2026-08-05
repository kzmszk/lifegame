-- SQLite cannot add a CHECK constraint to an existing table, so replace the
-- table while preserving the original column definitions and defaults.
CREATE TABLE tasks_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  due_date     TEXT,
  due_time     TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  tags         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  repeat_rule  TEXT,
  repeat_child_id INTEGER,
  CHECK (repeat_rule IS NULL OR (status = 'open' AND due_date IS NOT NULL))
);

INSERT INTO tasks_new (
  id, title, note, status, due_date, due_time, priority, tags,
  created_at, updated_at, completed_at, repeat_rule, repeat_child_id
)
SELECT
  id, title, note, status, due_date, due_time, priority, tags,
  created_at, updated_at, completed_at, NULL, NULL
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
