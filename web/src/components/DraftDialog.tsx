import { useRef, useState } from 'react';
import type { TaskDraft } from '../../../src/shared/types';
import {
  moveDeadlineToSchedule,
  repeatFormValue,
  repeatRuleFor,
} from '../repeat-form';
import type { RepeatFormValue } from '../repeat-form';
import { RepeatRuleFields } from './RepeatRuleFields';

export type DraftKind = 'task' | 'event';

export function DraftDialog({
  draft,
  source,
  onCancel,
  onConfirm,
}: {
  draft: TaskDraft;
  source: 'voice' | 'text';
  onCancel: () => void;
  onConfirm: (draft: TaskDraft, kind: DraftKind) => Promise<void>;
}) {
  const [value, setValue] = useState(draft);
  // A stated time is what distinguishes an appointment from a task, so it picks
  // the default. Recurrences are tasks, since Google Calendar is intentionally
  // outside this app's repeat-task model.
  const [kind, setKind] = useState<DraftKind>(
    draft.repeat_rule !== null || !draft.due_time ? 'task' : 'event',
  );
  const [repeat, setRepeat] = useState(() =>
    repeatFormValue(draft.repeat_rule),
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const set = <K extends keyof TaskDraft>(key: K, next: TaskDraft[K]) =>
    setValue((current) => ({ ...current, [key]: next }));
  const isRecurring = repeat.frequency !== 'none';
  const setRepeatValue = (next: RepeatFormValue) => {
    const wasRecurring = repeat.frequency !== 'none';
    setRepeat(next);
    if (next.frequency !== 'none') {
      if (!wasRecurring) setValue((current) => moveDeadlineToSchedule(current));
      setKind('task');
    }
  };
  const incompleteEvent =
    kind === 'event' && (!value.due_date || !value.due_time);
  const missingRepeatScheduledDate =
    kind === 'task' && isRecurring && !value.scheduled_date;
  const incomplete = incompleteEvent || missingRepeatScheduledDate;
  const confirm = async () => {
    if (!value.title.trim() || incomplete || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onConfirm({ ...value, repeat_rule: repeatRuleFor(repeat) }, kind);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="draft-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">
              {source === 'voice' ? 'VOICE' : 'QUICK'} DRAFT
            </p>
            <h2 id="draft-title">内容を確認</h2>
          </div>
          <button
            className="close-button"
            disabled={saving}
            onClick={onCancel}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <p className="draft-hint">
          {source === 'voice'
            ? '音声から読み取った内容です。必要ならここで直せます。'
            : isRecurring
              ? '繰り返しとして読み取りました。必要ならここで直せます。'
              : '時刻があるので予定として登録します。必要ならここで直せます。'}
        </p>
        {!isRecurring && (
          <div className="kind-switch" role="group" aria-label="登録先">
            <button
              type="button"
              className={kind === 'task' ? 'is-active' : ''}
              aria-pressed={kind === 'task'}
              disabled={saving}
              onClick={() => setKind('task')}
            >
              タスク
            </button>
            <button
              type="button"
              className={kind === 'event' ? 'is-active' : ''}
              aria-pressed={kind === 'event'}
              disabled={saving}
              onClick={() => setKind('event')}
            >
              予定
            </button>
          </div>
        )}
        <label>
          <span>タイトル</span>
          <input
            value={value.title}
            onChange={(event) => set('title', event.target.value)}
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            <span>
              {kind === 'event'
                ? '日付'
                : isRecurring
                  ? '初回の実行日'
                  : '期限'}
            </span>
            <input
              type="date"
              value={
                (isRecurring ? value.scheduled_date : value.due_date) ?? ''
              }
              onChange={(event) =>
                set(
                  isRecurring ? 'scheduled_date' : 'due_date',
                  event.target.value || null,
                )
              }
            />
          </label>
          <label>
            <span>
              {kind === 'event'
                ? '開始時刻'
                : isRecurring
                  ? '初回の実行時刻'
                  : '時刻'}
            </span>
            <input
              type="time"
              value={
                (isRecurring ? value.scheduled_time : value.due_time) ?? ''
              }
              onChange={(event) =>
                set(
                  isRecurring ? 'scheduled_time' : 'due_time',
                  event.target.value || null,
                )
              }
            />
          </label>
        </div>
        {kind === 'task' &&
          !isRecurring &&
          (value.scheduled_date || value.scheduled_time) && (
            <div className="form-row">
              <label>
                <span>実行予定日</span>
                <input
                  type="date"
                  value={value.scheduled_date ?? ''}
                  onChange={(event) =>
                    set('scheduled_date', event.target.value || null)
                  }
                />
              </label>
              <label>
                <span>実行予定時刻</span>
                <input
                  type="time"
                  value={value.scheduled_time ?? ''}
                  onChange={(event) =>
                    set('scheduled_time', event.target.value || null)
                  }
                />
              </label>
            </div>
          )}
        {incompleteEvent && (
          <p className="draft-warning">
            予定にするには日付と時刻の両方が必要です。
          </p>
        )}
        {missingRepeatScheduledDate && (
          <p className="draft-warning">繰り返しタスクには実行日が必要です。</p>
        )}
        {kind === 'task' && (
          <RepeatRuleFields
            value={repeat}
            onChange={setRepeatValue}
            disabled={saving}
          />
        )}
        <label>
          <span>メモ</span>
          <textarea
            value={value.note}
            onChange={(event) => set('note', event.target.value)}
            rows={3}
          />
        </label>
        {/* Priority is a task-list concept; Google Calendar has nothing to map it to. */}
        {kind === 'task' && (
          <label className="switch-row">
            <span>優先度を上げる</span>
            <input
              type="checkbox"
              checked={value.priority === 1}
              onChange={(event) =>
                set('priority', event.target.checked ? 1 : 0)
              }
            />
          </label>
        )}
        <div className="modal-actions">
          <button
            className="button secondary"
            disabled={saving}
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            className="button primary"
            onClick={() => void confirm()}
            disabled={saving || !value.title.trim() || incomplete}
          >
            {saving
              ? '追加中…'
              : kind === 'event'
                ? 'この内容で予定を追加'
                : 'この内容で追加'}
          </button>
        </div>
      </div>
    </div>
  );
}
