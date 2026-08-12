import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  HealthEntry,
  HealthEntryKind,
  HealthEntryUpdateInput,
} from '../../../src/shared/types';
import {
  createHealthEntry,
  deleteHealthEntry,
  fetchHealthEntries,
  updateHealthEntry,
} from '../api';
import { groupHealthEntries, localDateInputValue } from '../health';
import {
  createHealthHistoryLoader,
  INITIAL_HEALTH_HISTORY_STATE,
  type HealthHistoryLoader,
} from '../health-history-loader';
import { ErrorState, Loading } from './feedback';

/**
 * What a form can create, which is narrower than what a record can be: sleep
 * only ever arrives from the companion's sync, so there is no form for it and
 * no way to name it here.
 */
export type HealthEntryFormKind = 'weight' | 'exercise';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function numberValue(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface HealthEntryFormProps {
  kind: HealthEntryFormKind;
  onSaved: (entry: HealthEntry) => Promise<void>;
  onError?: (message: string) => void;
}

export function HealthEntryForm({
  kind,
  onSaved,
  onError,
}: HealthEntryFormProps) {
  return kind === 'weight' ? (
    <WeightMeasurementForm onSaved={onSaved} onError={onError} />
  ) : (
    <ExerciseSessionForm onSaved={onSaved} onError={onError} />
  );
}

function WeightMeasurementForm({
  onSaved,
  onError,
}: Omit<HealthEntryFormProps, 'kind'>) {
  const [occurredOn, setOccurredOn] = useState(localDateInputValue());
  const [weightKg, setWeightKg] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const weight = numberValue(weightKg);
    if (!occurredOn || weight === null || weight <= 0) {
      setError('記録対象日と、0より大きい体重を入力してください');
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const entry = await createHealthEntry({
        kind: 'weight',
        occurred_on: occurredOn,
        weight_kg: weight,
        note,
      });
      await onSaved(entry);
      setWeightKg('');
      setNote('');
      setOccurredOn(localDateInputValue());
    } catch (caught) {
      const message = errorMessage(caught, '体重測定の保存に失敗しました');
      setError(message);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="health-form-card" aria-labelledby="weight-form-title">
      <div className="health-form-heading">
        <p className="eyebrow">WEIGHT MEASUREMENT</p>
        <h2 id="weight-form-title">体重測定</h2>
      </div>
      <form className="health-form" onSubmit={submit}>
        <label>
          <span>記録対象日</span>
          <input
            type="date"
            value={occurredOn}
            required
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </label>
        <label>
          <span>体重 (kg)</span>
          <input
            type="number"
            value={weightKg}
            min="0.01"
            step="0.01"
            required
            inputMode="decimal"
            onChange={(event) => setWeightKg(event.target.value)}
          />
        </label>
        <label>
          <span>任意メモ</span>
          <textarea
            value={note}
            rows={2}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" type="submit" disabled={saving}>
          {saving ? '保存中…' : '体重測定を保存'}
        </button>
      </form>
    </section>
  );
}

function ExerciseSessionForm({
  onSaved,
  onError,
}: Omit<HealthEntryFormProps, 'kind'>) {
  const [occurredOn, setOccurredOn] = useState(localDateInputValue());
  const [activity, setActivity] = useState('');
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const durationMinutes = numberValue(duration);
    if (!occurredOn || !activity.trim()) {
      setError('記録対象日と種目名を入力してください');
      return;
    }
    if (
      durationMinutes !== null &&
      (!Number.isSafeInteger(durationMinutes) ||
        durationMinutes < 1 ||
        durationMinutes > 1440)
    ) {
      setError('時間は1分以上1440分以下の整数で入力してください');
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const entry = await createHealthEntry({
        kind: 'exercise',
        occurred_on: occurredOn,
        activity: activity.trim(),
        duration_minutes: durationMinutes,
        note,
      });
      await onSaved(entry);
      setActivity('');
      setDuration('');
      setNote('');
      setOccurredOn(localDateInputValue());
    } catch (caught) {
      const message = errorMessage(caught, '運動実績の保存に失敗しました');
      setError(message);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="health-form-card" aria-labelledby="exercise-form-title">
      <div className="health-form-heading">
        <p className="eyebrow">EXERCISE SESSION</p>
        <h2 id="exercise-form-title">運動実績</h2>
      </div>
      <form className="health-form" onSubmit={submit}>
        <label>
          <span>記録対象日</span>
          <input
            type="date"
            value={occurredOn}
            required
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </label>
        <label>
          <span>種目名</span>
          <input
            value={activity}
            required
            onChange={(event) => setActivity(event.target.value)}
          />
        </label>
        <label>
          <span>時間 (分)</span>
          <input
            type="number"
            value={duration}
            min="1"
            max="1440"
            step="1"
            inputMode="numeric"
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
        <label>
          <span>任意メモ</span>
          <textarea
            value={note}
            rows={2}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" type="submit" disabled={saving}>
          {saving ? '保存中…' : '運動実績を保存'}
        </button>
      </form>
    </section>
  );
}

interface HealthHistoryProps {
  entries: HealthEntry[];
  truncated: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  onUpdated: (entry: HealthEntry) => Promise<void>;
  onDeleted: (id: number) => Promise<void>;
}

export function HealthHistory({
  entries,
  truncated,
  loadingMore,
  loadMoreError,
  onLoadMore,
  onUpdated,
  onDeleted,
}: HealthHistoryProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (entry: HealthEntry) => {
    if (deletingId !== null) return;
    if (!window.confirm('この健康記録を削除しますか？')) return;
    setDeletingId(entry.id);
    setActionError(null);
    try {
      await deleteHealthEntry(entry.id);
      await onDeleted(entry.id);
      if (editingId === entry.id) setEditingId(null);
    } catch (caught) {
      setActionError(errorMessage(caught, '健康記録の削除に失敗しました'));
    } finally {
      setDeletingId(null);
    }
  };

  const groups = groupHealthEntries(entries);
  if (groups.length === 0) {
    return (
      <section
        className="health-history"
        aria-labelledby="health-history-title"
      >
        <h2 id="health-history-title">履歴</h2>
        <div className="empty-state">
          <p>健康記録はありません</p>
          <small>上の入力欄から記録を追加しましょう。</small>
        </div>
      </section>
    );
  }

  return (
    <section className="health-history" aria-labelledby="health-history-title">
      <div className="health-history-heading">
        <div>
          <p className="eyebrow">HEALTH ENTRIES</p>
          <h2 id="health-history-title">履歴</h2>
        </div>
        <span className="health-history-count">{entries.length}件</span>
      </div>
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="health-history-groups">
        {groups.map((group) => (
          <section className="health-history-group" key={group.occurred_on}>
            <h3>{group.occurred_on}</h3>
            <div className="health-entry-list">
              {group.entries.map((entry) => (
                <article className="health-entry-card" key={entry.id}>
                  <div className="health-entry-content">
                    <div className="health-entry-kind">
                      {entryKindLabel(entry)}
                    </div>
                    <strong>{entrySummary(entry)}</strong>
                    {entry.note && <p>{entry.note}</p>}
                  </div>
                  <div className="health-entry-actions">
                    {/* Sleep has no manual form to edit it back through, so the
                        button that would open one is not offered. Delete still
                        is: a wrong night should be removable. */}
                    {entry.kind !== 'sleep' && (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setEditingId(entry.id)}
                        disabled={deletingId !== null}
                      >
                        修正
                      </button>
                    )}
                    <button
                      type="button"
                      className="health-delete-button"
                      onClick={() => void remove(entry)}
                      disabled={deletingId !== null}
                    >
                      {deletingId === entry.id ? '削除中…' : '削除'}
                    </button>
                  </div>
                  {editingId === entry.id && (
                    <HealthEntryEditor
                      entry={entry}
                      onCancel={() => setEditingId(null)}
                      onSaved={async (saved) => {
                        await onUpdated(saved);
                        setEditingId(null);
                      }}
                    />
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      {truncated && (
        <div className="task-list-more health-history-more" aria-live="polite">
          {loadMoreError && <p role="alert">{loadMoreError}</p>}
          <button type="button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? '読み込み中…' : 'さらに読み込む'}
          </button>
        </div>
      )}
    </section>
  );
}

export type HealthEntryKindFilter = HealthEntryKind | 'all';

const KIND_FILTER_OPTIONS: ReadonlyArray<{
  value: HealthEntryKindFilter;
  label: string;
}> = [
  { value: 'all', label: 'すべて' },
  { value: 'weight', label: '体重' },
  { value: 'exercise', label: '運動' },
  { value: 'sleep', label: '睡眠' },
];

export function HealthKindFilter({
  value,
  onChange,
}: {
  value: HealthEntryKindFilter;
  onChange: (value: HealthEntryKindFilter) => void;
}) {
  return (
    <div
      className="health-kind-filter"
      role="group"
      aria-label="健康記録の種類で絞り込む"
    >
      {KIND_FILTER_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`health-kind-chip${value === option.value ? ' is-selected' : ''}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function entryKindLabel(entry: HealthEntry): string {
  if (entry.kind === 'weight') return '体重測定';
  if (entry.kind === 'exercise') return '運動実績';
  return '睡眠実績';
}

function entrySummary(entry: HealthEntry): string {
  if (entry.kind === 'weight') return `${entry.weight_kg} kg`;
  if (entry.kind === 'exercise') {
    return `${entry.activity}${entry.duration_minutes === null ? '' : ` · ${entry.duration_minutes}分`}`;
  }
  // A night reads as hours, not as the 445 minutes the row stores.
  const hours = Math.floor(entry.duration_minutes / 60);
  const minutes = entry.duration_minutes % 60;
  if (hours === 0) return `${minutes}分`;
  return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;
}

interface HealthEntryEditorProps {
  entry: HealthEntry;
  onCancel: () => void;
  onSaved: (entry: HealthEntry) => Promise<void>;
}

function HealthEntryEditor({
  entry,
  onCancel,
  onSaved,
}: HealthEntryEditorProps) {
  const [occurredOn, setOccurredOn] = useState(entry.occurred_on);
  const [weightKg, setWeightKg] = useState(
    entry.kind === 'weight' ? String(entry.weight_kg) : '',
  );
  const [activity, setActivity] = useState(
    entry.kind === 'exercise' ? entry.activity : '',
  );
  const [duration, setDuration] = useState(
    entry.kind === 'exercise' && entry.duration_minutes !== null
      ? String(entry.duration_minutes)
      : '',
  );
  const [note, setNote] = useState(entry.note);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let input: HealthEntryUpdateInput;
    if (entry.kind === 'weight') {
      const weight = numberValue(weightKg);
      if (!occurredOn || weight === null || weight <= 0) {
        setError('記録対象日と、0より大きい体重を入力してください');
        return;
      }
      input = {
        kind: 'weight',
        occurred_on: occurredOn,
        weight_kg: weight,
        note,
      };
    } else {
      const durationMinutes = numberValue(duration);
      if (!occurredOn || !activity.trim()) {
        setError('記録対象日と種目名を入力してください');
        return;
      }
      if (
        durationMinutes !== null &&
        (!Number.isSafeInteger(durationMinutes) ||
          durationMinutes < 1 ||
          durationMinutes > 1440)
      ) {
        setError('時間は1分以上1440分以下の整数で入力してください');
        return;
      }
      input = {
        kind: 'exercise',
        occurred_on: occurredOn,
        activity: activity.trim(),
        duration_minutes: durationMinutes,
        note,
      };
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateHealthEntry(entry.id, input);
      await onSaved(saved);
    } catch (caught) {
      setError(errorMessage(caught, '健康記録の保存に失敗しました'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="health-entry-editor" onSubmit={submit}>
      <label>
        <span>記録対象日</span>
        <input
          type="date"
          value={occurredOn}
          required
          onChange={(event) => setOccurredOn(event.target.value)}
        />
      </label>
      {entry.kind === 'weight' ? (
        <label>
          <span>体重 (kg)</span>
          <input
            type="number"
            value={weightKg}
            min="0.01"
            step="0.01"
            required
            onChange={(event) => setWeightKg(event.target.value)}
          />
        </label>
      ) : (
        <>
          <label>
            <span>種目名</span>
            <input
              value={activity}
              required
              onChange={(event) => setActivity(event.target.value)}
            />
          </label>
          <label>
            <span>時間 (分)</span>
            <input
              type="number"
              value={duration}
              min="1"
              max="1440"
              step="1"
              onChange={(event) => setDuration(event.target.value)}
            />
          </label>
        </>
      )}
      <label>
        <span>任意メモ</span>
        <textarea
          value={note}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="health-editor-actions">
        <button
          type="button"
          className="button secondary"
          onClick={onCancel}
          disabled={saving}
        >
          キャンセル
        </button>
        <button className="button primary" disabled={saving}>
          {saving ? '保存中…' : '変更を保存'}
        </button>
      </div>
    </form>
  );
}

export function HealthPage({
  onError,
}: {
  onError?: (message: string) => void;
}) {
  const [history, setHistory] = useState(INITIAL_HEALTH_HISTORY_STATE);
  const [kindFilter, setKindFilter] = useState<HealthEntryKindFilter>('all');

  // The filter goes to the server rather than to the loaded array. The page is
  // cut before it arrives, so filtering here would show only the matches inside
  // the first page and present that as the whole history — which is how a night
  // that is stored can look like a night that was never recorded.
  //
  // The loader also owns "only the newest request may write", which is why it
  // lives outside React: that rule is about the order responses come back in,
  // and it is testable there without driving a component.
  const loaderRef = useRef<HealthHistoryLoader | null>(null);
  loaderRef.current ??= createHealthHistoryLoader(
    fetchHealthEntries,
    setHistory,
  );

  const loadEntries = useCallback(
    async (offset = 0) => {
      await loaderRef.current!.load({
        offset,
        ...(kindFilter === 'all' ? {} : { kind: kindFilter }),
      });
    },
    [kindFilter],
  );

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const refresh = useCallback(async () => {
    await loadEntries();
  }, [loadEntries]);

  return (
    <>
      <header className="page-header health-page-header">
        <div>
          <p className="eyebrow">LIFE GAME</p>
          <h1>健康</h1>
        </div>
      </header>
      <div className="health-forms">
        <HealthEntryForm kind="weight" onSaved={refresh} onError={onError} />
        <HealthEntryForm kind="exercise" onSaved={refresh} onError={onError} />
      </div>
      {/* Outside the loading branch on purpose: a filter that disappears while
          its own results are loading cannot be corrected mid-flight, and the
          list jumping between three states and none is worse than a stale
          heading. */}
      <HealthKindFilter value={kindFilter} onChange={setKindFilter} />
      {history.loading ? (
        <Loading />
      ) : history.loadError ? (
        <ErrorState
          message={history.loadError}
          onRetry={() => void loadEntries()}
        />
      ) : (
        <HealthHistory
          entries={history.entries}
          truncated={history.truncated}
          loadingMore={history.loadingMore}
          loadMoreError={history.loadMoreError}
          onLoadMore={() => {
            if (history.nextOffset !== null)
              void loadEntries(history.nextOffset);
          }}
          onUpdated={refresh}
          onDeleted={refresh}
        />
      )}
    </>
  );
}
