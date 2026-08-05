-- `due_*` is a deadline, while `scheduled_*` is an execution schedule. SQLite
-- cannot alter a CHECK constraint, so rebuild as 0003 did while preserving ids,
-- timestamps, indexes, and the AUTOINCREMENT high-water mark.
CREATE TABLE tasks_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'open',
  due_date          TEXT,
  due_time          TEXT,
  scheduled_date    TEXT,
  scheduled_time    TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  tags              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,
  repeat_rule       TEXT,
  repeat_child_id   INTEGER,
  CHECK (scheduled_time IS NULL OR scheduled_date IS NOT NULL),
  CHECK (
    repeat_rule IS NULL OR
    (status = 'open' AND scheduled_date IS NOT NULL AND due_date IS NULL AND due_time IS NULL)
  )
);

-- Existing recurring rows used due_* as their occurrence schedule. A stopped
-- terminal child has neither repeat column itself, but remains identifiable by
-- a parent pointing at it. Move rather than copy so the new deadline columns
-- never retain the old ambiguous role.
INSERT INTO tasks_new (
  id, title, note, status, due_date, due_time, scheduled_date, scheduled_time,
  priority, tags, created_at, updated_at, completed_at, repeat_rule, repeat_child_id
)
SELECT
  source.id, source.title, source.note, source.status,
  CASE WHEN source.repeat_rule IS NOT NULL OR source.repeat_child_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM tasks AS parent WHERE parent.repeat_child_id = source.id
  ) THEN NULL ELSE source.due_date END,
  CASE WHEN source.repeat_rule IS NOT NULL OR source.repeat_child_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM tasks AS parent WHERE parent.repeat_child_id = source.id
  ) THEN NULL ELSE source.due_time END,
  CASE WHEN source.repeat_rule IS NOT NULL OR source.repeat_child_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM tasks AS parent WHERE parent.repeat_child_id = source.id
  ) THEN source.due_date ELSE NULL END,
  CASE WHEN source.repeat_rule IS NOT NULL OR source.repeat_child_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM tasks AS parent WHERE parent.repeat_child_id = source.id
  ) THEN source.due_time ELSE NULL END,
  source.priority, source.tags, source.created_at, source.updated_at,
  source.completed_at, source.repeat_rule, source.repeat_child_id
FROM tasks AS source;

CREATE TABLE tasks_seq_backup AS
  SELECT seq FROM sqlite_sequence WHERE name = 'tasks';

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

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
CREATE INDEX idx_tasks_status_scheduled ON tasks(status, scheduled_date);
