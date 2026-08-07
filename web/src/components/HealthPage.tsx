import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  HealthEntry,
  HealthEntryUpdateInput,
} from '../../../src/shared/types';
import {
  createHealthEntry,
  deleteHealthEntry,
  fetchHealthEntries,
  updateHealthEntry,
} from '../api';
import { groupHealthEntries, localDateInputValue } from '../health';
import { ErrorState, Loading } from './feedback';

export type HealthEntryKind = 'weight' | 'exercise';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function numberValue(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface HealthEntryFormProps {
  kind: HealthEntryKind;
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
                      {entry.kind === 'weight' ? '体重測定' : '運動実績'}
                    </div>
                    <strong>{entrySummary(entry)}</strong>
                    {entry.note && <p>{entry.note}</p>}
                  </div>
                  <div className="health-entry-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setEditingId(entry.id)}
                      disabled={deletingId !== null}
                    >
                      修正
                    </button>
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

function entrySummary(entry: HealthEntry): string {
  return entry.kind === 'weight'
    ? `${entry.weight_kg} kg`
    : `${entry.activity}${entry.duration_minutes === null ? '' : ` · ${entry.duration_minutes}分`}`;
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
  const [entries, setEntries] = useState<HealthEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const loadEntries = useCallback(async (offset = 0) => {
    const appending = offset > 0;
    if (appending) {
      setLoadingMore(true);
      setLoadMoreError(null);
    } else {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const response = await fetchHealthEntries({ offset });
      setEntries((current) =>
        appending ? [...current, ...response.entries] : response.entries,
      );
      setTruncated(response.truncated);
      setNextOffset(response.next_offset);
    } catch (caught) {
      const message = errorMessage(caught, '健康記録の取得に失敗しました');
      if (appending) setLoadMoreError(message);
      else setLoadError(message);
    } finally {
      if (appending) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

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
      {loading ? (
        <Loading />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void loadEntries()} />
      ) : (
        <HealthHistory
          entries={entries}
          truncated={truncated}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={() => {
            if (nextOffset !== null) void loadEntries(nextOffset);
          }}
          onUpdated={refresh}
          onDeleted={refresh}
        />
      )}
    </>
  );
}
