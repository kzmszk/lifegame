import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Task } from '../../../src/shared/types';
import { fetchTask, removeTask, updateTask } from '../api';
import {
  moveDeadlineToSchedule,
  repeatFormValue,
  repeatRuleFor,
} from '../repeat-form';
import type { RepeatFormValue } from '../repeat-form';
import { Loading } from './feedback';
import { RepeatRuleFields } from './RepeatRuleFields';

type EditableTask = Pick<
  Task,
  | 'title'
  | 'note'
  | 'due_date'
  | 'due_time'
  | 'scheduled_date'
  | 'scheduled_time'
  | 'priority'
  | 'tags'
> & {
  repeat: RepeatFormValue;
};

function editableTask(task: Task): EditableTask {
  return {
    title: task.title,
    note: task.note,
    due_date: task.due_date,
    due_time: task.due_time,
    scheduled_date: task.scheduled_date,
    scheduled_time: task.scheduled_time,
    priority: task.priority,
    tags: task.tags,
    repeat: repeatFormValue(task.repeat_rule),
  };
}

export function TaskDetail({
  id,
  onBack,
  onDeleted,
  onError,
}: {
  id: number;
  onBack: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [form, setForm] = useState<EditableTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchTask(id)
      .then((loaded) => {
        if (cancelled) return;
        setTask(loaded);
        setForm(editableTask(loaded));
      })
      .catch((error) =>
        onError(
          error instanceof Error ? error.message : 'タスクの取得に失敗しました',
        ),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, onError]);

  if (loading)
    return (
      <>
        <header className="detail-header">
          <button className="back-button" onClick={onBack}>
            ‹
          </button>
          <h1>詳細</h1>
        </header>
        <Loading />
      </>
    );
  if (!task || !form)
    return (
      <>
        <header className="detail-header">
          <button className="back-button" onClick={onBack}>
            ‹
          </button>
          <h1>詳細</h1>
        </header>
        <div className="empty-state">タスクが見つかりません。</div>
      </>
    );

  const setField = <K extends keyof EditableTask>(
    key: K,
    value: EditableTask[K],
  ) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const isRecurring = repeatRuleFor(form.repeat) !== null;
  const missingRepeatScheduledDate =
    isRecurring && form.scheduled_date === null;
  const changeRepeat = (next: RepeatFormValue) => {
    setForm((current) => {
      if (!current) return current;
      const wasRecurring = repeatRuleFor(current.repeat) !== null;
      const nextForm = { ...current, repeat: next };
      // Turning recurrence on is an explicit conversion: the old deadline is
      // moved to the occurrence schedule and cleared, never reinterpreted.
      return !wasRecurring && repeatRuleFor(next) !== null
        ? moveDeadlineToSchedule(nextForm)
        : nextForm;
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || missingRepeatScheduledDate || saving) return;
    setSaving(true);
    try {
      const { repeat, ...fields } = form;
      const saved = await updateTask(id, {
        ...fields,
        title: form.title.trim(),
        repeat_rule: repeatRuleFor(repeat),
      });
      setTask(saved);
      setForm(editableTask(saved));
    } catch (error) {
      onError(error instanceof Error ? error.message : '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    if (statusUpdating) return;
    setStatusUpdating(true);
    try {
      const saved = await updateTask(id, {
        status: task.status === 'done' ? 'open' : 'done',
      });
      setTask(saved);
      // Completion moves the rule to the generated child. Keep unrelated
      // unsaved edits, but replace the form's stale recurrence state so a later
      // save cannot try to put the rule back onto the completed parent.
      setForm((current) =>
        current
          ? { ...current, repeat: repeatFormValue(saved.repeat_rule) }
          : current,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : '更新に失敗しました');
    } finally {
      setStatusUpdating(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('このタスクを削除しますか？')) return;
    try {
      await removeTask(id);
      onDeleted();
    } catch (error) {
      onError(error instanceof Error ? error.message : '削除に失敗しました');
    }
  };

  return (
    <>
      <header className="detail-header">
        <button className="back-button" onClick={onBack}>
          ‹
        </button>
        <div>
          <p className="eyebrow">TASK DETAIL</p>
          <h1>タスク詳細</h1>
        </div>
      </header>
      <form className="detail-form" onSubmit={submit}>
        <label className="detail-title">
          <span>タイトル</span>
          <input
            value={form.title}
            onChange={(event) => setField('title', event.target.value)}
            autoFocus
          />
        </label>
        <button
          type="button"
          className={`status-toggle ${task.status === 'done' ? 'done' : ''}`}
          disabled={statusUpdating}
          onClick={() => void toggle()}
        >
          {statusUpdating
            ? '更新中…'
            : task.status === 'done'
              ? '✓ 完了'
              : '○ 未完了'}
        </button>
        <label>
          <span>メモ</span>
          <textarea
            value={form.note}
            onChange={(event) => setField('note', event.target.value)}
            rows={5}
            placeholder="補足を書いておく"
          />
        </label>
        {!isRecurring && (
          <div className="form-row">
            <label>
              <span>期限</span>
              <input
                type="date"
                value={form.due_date ?? ''}
                onChange={(event) =>
                  setField('due_date', event.target.value || null)
                }
              />
            </label>
            <label>
              <span>時刻</span>
              <input
                type="time"
                value={form.due_time ?? ''}
                onChange={(event) =>
                  setField('due_time', event.target.value || null)
                }
              />
            </label>
          </div>
        )}
        <RepeatRuleFields
          value={form.repeat}
          onChange={changeRepeat}
          disabled={task.status === 'done'}
        />
        {(isRecurring || form.scheduled_date || form.scheduled_time) && (
          <div className="form-row">
            <label>
              <span>{isRecurring ? '今回の実行日' : '実行予定日'}</span>
              <input
                type="date"
                value={form.scheduled_date ?? ''}
                onChange={(event) =>
                  setField('scheduled_date', event.target.value || null)
                }
              />
            </label>
            <label>
              <span>{isRecurring ? '今回の実行時刻' : '実行予定時刻'}</span>
              <input
                type="time"
                value={form.scheduled_time ?? ''}
                onChange={(event) =>
                  setField('scheduled_time', event.target.value || null)
                }
              />
            </label>
          </div>
        )}
        {missingRepeatScheduledDate && (
          <p className="draft-warning">繰り返しタスクには実行日が必要です。</p>
        )}
        {task.status === 'done' && (
          <p className="repeat-help">
            完了したタスクは繰り返しを変更できません。次回のタスクを編集してください。
          </p>
        )}
        <label className="switch-row">
          <span>優先度を上げる</span>
          <input
            type="checkbox"
            checked={form.priority === 1}
            onChange={(event) =>
              setField('priority', event.target.checked ? 1 : 0)
            }
          />
        </label>
        <label>
          <span>タグ</span>
          <input
            value={form.tags}
            onChange={(event) => setField('tags', event.target.value)}
            placeholder="仕事, 個人"
          />
        </label>
        <button
          className="button primary save-button"
          disabled={saving || missingRepeatScheduledDate}
        >
          {saving ? '保存中…' : '変更を保存'}
        </button>
      </form>
      <button className="delete-button" onClick={() => void remove()}>
        このタスクを削除
      </button>
    </>
  );
}
