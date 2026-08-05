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

-- DROP TABLE deletes the old sqlite_sequence row, and copying explicit ids only
-- carries the sequence up to the highest surviving id. If the newest tasks had
-- been deleted, their ids would be handed out again, which AUTOINCREMENT exists
-- to prevent -- and a task id an MCP client is still holding would then name a
-- different task. Carry the high-water mark across by hand.
CREATE TABLE tasks_seq_backup AS
  SELECT seq FROM sqlite_sequence WHERE name = 'tasks';

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- The rename leaves a row only if the copy inserted at least one id.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'tasks', (SELECT MAX(seq) FROM tasks_seq_backup)
WHERE (SELECT MAX(seq) FROM tasks_seq_backup) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tasks');

UPDATE sqlite_sequence
SET seq = (SELECT MAX(seq) FROM tasks_seq_backup)
WHERE name = 'tasks'
  AND (SELECT MAX(seq) FROM tasks_seq_backup) > seq;

DROP TABLE tasks_seq_backup;

CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
