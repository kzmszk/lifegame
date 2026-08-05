import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  CalendarEvent,
  Connection,
  Task,
  TaskDraft,
  TaskStatus,
  TaskView,
} from '../../src/shared/types';
import type { RepeatRule } from '../../src/lib/repeat';
import {
  createCalendarEvent,
  createTask,
  fetchCalendarEvents,
  fetchConnections,
  fetchTask,
  fetchTasks,
  parseTask,
  removeConnection,
  removeTask,
  updateTask,
} from './api';

type Route =
  | { kind: 'list'; view: TaskView }
  | { kind: 'detail'; id: number; from: TaskView }
  | { kind: 'settings' };

/** Where a confirmed draft is written: the task list, or Google Calendar. */
type DraftKind = 'task' | 'event';

interface PendingDraft {
  draft: TaskDraft;
  /** Voice drafts get a different hint, since misheard text is the usual worry. */
  source: 'voice' | 'text';
}

type RepeatFrequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'every';

interface RepeatFormValue {
  frequency: RepeatFrequency;
  weeklyDays: number[];
  monthlyDay: number;
  everyDays: number;
}

const WEEKDAY_OPTIONS = [
  { value: 0, label: '日' },
  { value: 1, label: '月' },
  { value: 2, label: '火' },
  { value: 3, label: '水' },
  { value: 4, label: '木' },
  { value: 5, label: '金' },
  { value: 6, label: '土' },
] as const;

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function repeatFormValue(rule: RepeatRule | null): RepeatFormValue {
  if (rule === 'daily') {
    return { frequency: 'daily', weeklyDays: [1], monthlyDay: 1, everyDays: 1 };
  }
  if (rule?.startsWith('weekly:')) {
    const weeklyDays = rule
      .slice('weekly:'.length)
      .split(',')
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((left, right) => left - right);
    return {
      frequency: 'weekly',
      weeklyDays: weeklyDays.length > 0 ? weeklyDays : [1],
      monthlyDay: 1,
      everyDays: 1,
    };
  }
  if (rule?.startsWith('monthly:')) {
    return {
      frequency: 'monthly',
      weeklyDays: [1],
      monthlyDay: clampInteger(Number(rule.slice('monthly:'.length)), 1, 31),
      everyDays: 1,
    };
  }
  if (rule?.startsWith('every:')) {
    return {
      frequency: 'every',
      weeklyDays: [1],
      monthlyDay: 1,
      everyDays: clampInteger(Number(rule.slice('every:'.length)), 1, 366),
    };
  }
  return { frequency: 'none', weeklyDays: [1], monthlyDay: 1, everyDays: 1 };
}

function repeatRuleFor(value: RepeatFormValue): RepeatRule | null {
  if (value.frequency === 'none') return null;
  if (value.frequency === 'daily') return 'daily';
  if (value.frequency === 'weekly') {
    const days = [...new Set(value.weeklyDays)]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((left, right) => left - right);
    return days.length > 0 ? (`weekly:${days.join(',')}` as RepeatRule) : null;
  }
  if (value.frequency === 'monthly') {
    return `monthly:${clampInteger(value.monthlyDay, 1, 31)}` as RepeatRule;
  }
  return `every:${clampInteger(value.everyDays, 1, 366)}` as RepeatRule;
}

/** Recurrence operates on an execution schedule, never on a deadline. */
function moveDeadlineToSchedule<
  T extends Pick<
    TaskDraft,
    'due_date' | 'due_time' | 'scheduled_date' | 'scheduled_time'
  >,
>(value: T): T {
  const hasSchedule =
    value.scheduled_date !== null || value.scheduled_time !== null;
  return {
    ...value,
    scheduled_date: hasSchedule ? value.scheduled_date : value.due_date,
    scheduled_time: hasSchedule ? value.scheduled_time : value.due_time,
    due_date: null,
    due_time: null,
  };
}

function isTaskView(value: string | null): value is TaskView {
  return value === 'today' || value === 'inbox' || value === 'all';
}

function routeForPath(pathWithSearch: string): Route {
  const [pathname, search = ''] = pathWithSearch.split('?');
  const detail = pathname.match(/^\/tasks\/(\d+)$/);
  if (detail) {
    const from = new URLSearchParams(search).get('from');
    return {
      kind: 'detail',
      id: Number(detail[1]),
      from: isTaskView(from) ? from : 'today',
    };
  }
  if (pathname === '/settings') return { kind: 'settings' };
  if (pathname === '/inbox') return { kind: 'list', view: 'inbox' };
  if (pathname === '/all') return { kind: 'list', view: 'all' };
  return { kind: 'list', view: 'today' };
}

function pathForView(view: TaskView): string {
  return view === 'today' ? '/' : `/${view}`;
}

function useToast(): [string | null, (message: string) => void] {
  const [toast, setToast] = useState<string | null>(null);
  const show = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }, []);
  return [toast, show];
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const viewTitles: Record<TaskView, string> = {
  today: '今日',
  inbox: 'Inbox',
  all: '一覧',
};

export default function App() {
  const [path, setPath] = useState(
    window.location.pathname + window.location.search,
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const [draft, setDraft] = useState<PendingDraft | null>(null);
  const route = routeForPath(path);
  const listView = route.kind === 'list' ? route.view : null;
  const routeRef = useRef<Route>(route);
  routeRef.current = route;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsFailed, setEventsFailed] = useState(false);
  const listRequestGeneration = useRef(0);
  const eventRequestGeneration = useRef(0);
  const updatingTaskIdsRef = useRef(new Set<number>());
  const [updatingTaskIds, setUpdatingTaskIds] = useState<Set<number>>(
    new Set(),
  );

  useEffect(() => {
    const onPopState = () =>
      setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const loadList = useCallback(async (view: TaskView) => {
    const generation = ++listRequestGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const nextTasks = await fetchTasks(view);
      if (generation !== listRequestGeneration.current) return;
      const currentRoute = routeRef.current;
      if (currentRoute.kind !== 'list' || currentRoute.view !== view) return;
      setTasks(nextTasks);
    } catch (error) {
      if (generation !== listRequestGeneration.current) return;
      setLoadError(
        error instanceof Error ? error.message : 'タスクの取得に失敗しました',
      );
    } finally {
      if (generation === listRequestGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (listView !== null) void loadList(listView);
  }, [listView, loadList]);

  // Calendar events load on their own request so a slow or broken Google call
  // never delays or blanks the task list, which works without them.
  const loadEvents = useCallback(async () => {
    const generation = ++eventRequestGeneration.current;
    setEventsFailed(false);
    try {
      const nextEvents = await fetchCalendarEvents();
      if (generation !== eventRequestGeneration.current) return;
      setEvents(nextEvents);
    } catch {
      if (generation !== eventRequestGeneration.current) return;
      setEvents([]);
      setEventsFailed(true);
    }
  }, []);

  useEffect(() => {
    if (listView !== 'today') {
      // Bump the generation so an in-flight response cannot land on another view.
      eventRequestGeneration.current += 1;
      setEvents([]);
      setEventsFailed(false);
      return;
    }
    void loadEvents();
  }, [listView, loadEvents]);

  const handleCreate = useCallback(
    async (text: string) => {
      const parsed = await parseTask(text);
      // A stated time means an appointment, and recurrence needs a final chance
      // to correct natural-language parsing. Both branches stop for confirmation;
      // plain one-off tasks can still be added in one step.
      if (
        parsed.due_time ||
        parsed.scheduled_time ||
        parsed.repeat_rule !== null
      ) {
        setDraft({ draft: parsed, source: 'text' });
        return;
      }
      const task = await createTask(parsed);
      const currentRoute = routeRef.current;
      if (currentRoute.kind === 'list') await loadList(currentRoute.view);
      showToast(`「${task.title}」を追加しました`);
    },
    [loadList, showToast],
  );

  const handleVoice = useCallback(async (text: string) => {
    // Speech recognition mishears, so voice always confirms, time or not.
    setDraft({ draft: await parseTask(text), source: 'voice' });
  }, []);

  const handleToggle = useCallback(
    async (task: Task) => {
      if (updatingTaskIdsRef.current.has(task.id)) return;
      updatingTaskIdsRef.current.add(task.id);
      setUpdatingTaskIds(new Set(updatingTaskIdsRef.current));
      const nextStatus: TaskStatus = task.status === 'done' ? 'open' : 'done';
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id ? { ...item, status: nextStatus } : item,
        ),
      );
      try {
        await updateTask(task.id, { status: nextStatus });
        const currentRoute = routeRef.current;
        if (currentRoute.kind === 'list') await loadList(currentRoute.view);
      } catch (error) {
        setTasks((current) =>
          current.map((item) => (item.id === task.id ? task : item)),
        );
        showToast(
          error instanceof Error ? error.message : '更新に失敗しました',
        );
      } finally {
        updatingTaskIdsRef.current.delete(task.id);
        setUpdatingTaskIds(new Set(updatingTaskIdsRef.current));
      }
    },
    [loadList, showToast],
  );

  const confirmDraft = useCallback(
    async (nextDraft: TaskDraft, kind: DraftKind) => {
      try {
        if (kind === 'event') {
          if (!nextDraft.due_date || !nextDraft.due_time) {
            showToast('予定にするには日付と時刻が必要です');
            return;
          }
          await createCalendarEvent({
            title: nextDraft.title,
            date: nextDraft.due_date,
            start_time: nextDraft.due_time,
            note: nextDraft.note,
          });
          setDraft(null);
          // The new event may fall on today, and refetching is cheaper than
          // reasoning about whether it does.
          if (routeRef.current.kind === 'list') await loadEvents();
          showToast('予定を追加しました');
          return;
        }
        await createTask(nextDraft);
        setDraft(null);
        const currentRoute = routeRef.current;
        if (currentRoute.kind === 'list') await loadList(currentRoute.view);
        showToast('タスクを追加しました');
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '追加に失敗しました',
        );
      }
    },
    [loadEvents, loadList, showToast],
  );

  return (
    <div className="app-shell">
      <main className="page">
        {route.kind === 'list' ? (
          <>
            <header className="page-header">
              <div>
                <p className="eyebrow">LIFE GAME</p>
                <h1>{viewTitles[route.view]}</h1>
              </div>
              <button
                className="header-mark"
                type="button"
                onClick={() => navigate('/settings')}
                aria-label="設定を開く"
              >
                ●
              </button>
            </header>
            <QuickAdd
              onAdd={handleCreate}
              onVoiceText={handleVoice}
              onError={showToast}
            />
            {route.view === 'today' && (
              <CalendarEventList
                events={events}
                failed={eventsFailed}
                onRetry={() => void loadEvents()}
              />
            )}
            {loading ? (
              <Loading />
            ) : loadError ? (
              <ErrorState
                message={loadError}
                onRetry={() => void loadList(route.view)}
              />
            ) : (
              <TaskList
                tasks={tasks}
                view={route.view}
                updatingTaskIds={updatingTaskIds}
                onToggle={handleToggle}
                onOpen={(id) => navigate(`/tasks/${id}?from=${route.view}`)}
              />
            )}
          </>
        ) : route.kind === 'detail' ? (
          <TaskDetail
            id={route.id}
            onBack={() => navigate(pathForView(route.from))}
            onDeleted={() => navigate(pathForView(route.from))}
            onError={showToast}
          />
        ) : (
          <ConnectionSettings
            onBack={() => navigate('/')}
            onError={showToast}
          />
        )}
      </main>
      {route.kind === 'list' && <BottomTabs view={route.view} />}
      {draft && (
        <DraftDialog
          draft={draft.draft}
          source={draft.source}
          onCancel={() => setDraft(null)}
          onConfirm={confirmDraft}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/**
 * Google returns anything overlapping the day, so an event may already be under
 * way or run past midnight. Showing a bare start time would announce something
 * that began last night as starting tonight.
 */
function eventTimeLabel(event: CalendarEvent): string {
  if (event.all_day || (event.started_earlier && event.ends_later))
    return '終日';
  if (event.started_earlier) return `〜${event.end_time}`;
  if (event.ends_later) return `${event.start_time}〜`;
  return event.start_time ?? '';
}

function CalendarEventList({
  events,
  failed,
  onRetry,
}: {
  events: CalendarEvent[];
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <div className="notice calendar-notice">
        <span>予定を取得できませんでした</span>
        <button type="button" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  // Nothing to show while loading or on a free day; an empty box would just be noise.
  if (events.length === 0) return null;

  return (
    <section className="event-list" aria-label="今日の予定">
      <h2 className="event-list-title">予定</h2>
      {events.map((event) => (
        <article className="event-card" key={event.id}>
          <span className="event-time">{eventTimeLabel(event)}</span>
          <div className="event-main">
            <p className="event-title">{event.title}</p>
            {event.location && (
              <p className="event-location">{event.location}</p>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

function Loading() {
  return (
    <div className="loading">
      <span className="spinner" />
      読み込み中…
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="empty-state error-state">
      <p>{message}</p>
      <button className="button secondary" onClick={onRetry}>
        再読み込み
      </button>
    </div>
  );
}

function QuickAdd({
  onAdd,
  onVoiceText,
  onError,
}: {
  onAdd: (text: string) => Promise<void>;
  onVoiceText: (text: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognizer | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd(text.trim());
      setText('');
    } catch (error) {
      onError(
        error instanceof Error ? error.message : 'タスクの追加に失敗しました',
      );
    } finally {
      setSaving(false);
    }
  };

  const startVoice = () => {
    const SpeechRecognitionCtor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      onError('このブラウザは音声入力に対応していません');
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'ja-JP';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      setListening(false);
      if (transcript) {
        setText('');
        void onVoiceText(transcript).catch((error) =>
          onError(
            error instanceof Error ? error.message : '音声の解析に失敗しました',
          ),
        );
      }
    };
    recognition.onerror = () => {
      setListening(false);
      onError('音声を認識できませんでした');
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  return (
    <form className="quick-add" onSubmit={submit}>
      <button
        className="plus"
        type="submit"
        disabled={!text.trim() || saving}
        aria-label="このタスクを追加"
      >
        ＋
      </button>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="タスクを追加…"
        aria-label="タスクを追加"
      />
      <button
        className={`voice-button ${listening ? 'is-listening' : ''}`}
        type="button"
        onClick={startVoice}
        aria-label="音声入力"
      >
        {listening ? '◉' : '🎤'}
      </button>
      {saving && <span className="mini-spinner" aria-label="保存中" />}
    </form>
  );
}

function RepeatRuleFields({
  value,
  onChange,
  disabled = false,
}: {
  value: RepeatFormValue;
  onChange: (value: RepeatFormValue) => void;
  disabled?: boolean;
}) {
  const setFrequency = (frequency: RepeatFrequency) =>
    onChange({
      ...value,
      frequency,
      weeklyDays: value.weeklyDays.length > 0 ? value.weeklyDays : [1],
    });
  const setWeekday = (weekday: number, checked: boolean) => {
    const weeklyDays = checked
      ? [...new Set([...value.weeklyDays, weekday])].sort(
          (left, right) => left - right,
        )
      : value.weeklyDays.length > 1
        ? value.weeklyDays.filter((day) => day !== weekday)
        : value.weeklyDays;
    onChange({ ...value, weeklyDays });
  };

  return (
    <fieldset className="repeat-settings" disabled={disabled}>
      <legend>繰り返し</legend>
      <label>
        <span>頻度</span>
        <select
          value={value.frequency}
          onChange={(event) =>
            setFrequency(event.target.value as RepeatFrequency)
          }
          aria-label="繰り返しの頻度"
        >
          <option value="none">なし</option>
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
          <option value="monthly">毎月</option>
          <option value="every">N日ごと</option>
        </select>
      </label>
      {value.frequency === 'weekly' && (
        <div className="repeat-weekdays" role="group" aria-label="繰り返す曜日">
          <span>曜日</span>
          <div className="weekday-options">
            {WEEKDAY_OPTIONS.map((weekday) => {
              const isOnlySelectedDay =
                value.weeklyDays.length === 1 &&
                value.weeklyDays[0] === weekday.value;
              return (
                <label className="weekday-option" key={weekday.value}>
                  <input
                    type="checkbox"
                    checked={value.weeklyDays.includes(weekday.value)}
                    disabled={isOnlySelectedDay}
                    onChange={(event) =>
                      setWeekday(weekday.value, event.target.checked)
                    }
                  />
                  <span>{weekday.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {value.frequency === 'monthly' && (
        <label className="repeat-number">
          <span>毎月の日</span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="31"
            value={value.monthlyDay}
            onChange={(event) =>
              onChange({
                ...value,
                monthlyDay: clampInteger(Number(event.target.value), 1, 31),
              })
            }
          />
          <span>日</span>
        </label>
      )}
      {value.frequency === 'every' && (
        <label className="repeat-number">
          <span>間隔</span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="366"
            value={value.everyDays}
            onChange={(event) =>
              onChange({
                ...value,
                everyDays: clampInteger(Number(event.target.value), 1, 366),
              })
            }
          />
          <span>日ごと</span>
        </label>
      )}
      {value.frequency !== 'none' && (
        <p className="repeat-help">
          完了すると次回のタスクを1件作成します。なしを選ぶと以後は作成しません。
        </p>
      )}
    </fieldset>
  );
}

function TaskList({
  tasks,
  view,
  updatingTaskIds,
  onToggle,
  onOpen,
}: {
  tasks: Task[];
  view: TaskView;
  updatingTaskIds: ReadonlySet<number>;
  onToggle: (task: Task) => Promise<void>;
  onOpen: (id: number) => void;
}) {
  if (tasks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">☼</div>
        <p>{view === 'inbox' ? 'Inbox は空です' : 'タスクはありません'}</p>
        <small>上の入力欄から、次の一手を追加しましょう。</small>
      </div>
    );
  }
  return (
    <section className="task-list" aria-label="タスク一覧">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          updating={updatingTaskIds.has(task.id)}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}

function TaskCard({
  task,
  updating,
  onToggle,
  onOpen,
}: {
  task: Task;
  updating: boolean;
  onToggle: (task: Task) => Promise<void>;
  onOpen: (id: number) => void;
}) {
  return (
    <article className={`task-card ${task.status === 'done' ? 'is-done' : ''}`}>
      <button
        className="check-button"
        disabled={updating}
        aria-busy={updating}
        onClick={() => void onToggle(task)}
        aria-label={task.status === 'done' ? '未完了に戻す' : '完了にする'}
      >
        {task.status === 'done' ? '✓' : ''}
      </button>
      <button className="task-main" onClick={() => onOpen(task.id)}>
        <span className="task-title">{task.title}</span>
        {(task.due_date ||
          task.due_time ||
          task.scheduled_date ||
          task.scheduled_time ||
          task.priority === 1 ||
          task.tags ||
          task.repeat_rule !== null ||
          task.repeat_child_id !== null) && (
          <span className="task-meta">
            {task.due_date && (
              <span className="due">
                期限: {task.due_date}
                {task.due_time ? ` ${task.due_time}` : ''}
              </span>
            )}
            {task.scheduled_date && (
              <span className="due">
                実行: {task.scheduled_date}
                {task.scheduled_time ? ` ${task.scheduled_time}` : ''}
              </span>
            )}
            {task.priority === 1 && <span className="priority">高</span>}
            {task.tags && <span>{task.tags}</span>}
            {(task.repeat_rule !== null || task.repeat_child_id !== null) && (
              <span className="repeat-mark" aria-label="繰り返しタスク">
                ↻
              </span>
            )}
          </span>
        )}
      </button>
      <button
        className="more-button"
        onClick={() => onOpen(task.id)}
        aria-label="詳細を開く"
      >
        ›
      </button>
    </article>
  );
}

function BottomTabs({ view }: { view: TaskView }) {
  return (
    <nav className="bottom-tabs" aria-label="メインナビゲーション">
      {(['today', 'inbox', 'all'] as TaskView[]).map((item) => (
        <button
          key={item}
          className={view === item ? 'active' : ''}
          onClick={() => navigate(pathForView(item))}
        >
          <span className="tab-icon">
            {item === 'today' ? '◷' : item === 'inbox' ? '□' : '☷'}
          </span>
          <span>{viewTitles[item]}</span>
        </button>
      ))}
    </nav>
  );
}

function ConnectionSettings({
  onBack,
  onError,
}: {
  onBack: () => void;
  onError: (message: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchConnections();
      setConnections(response.connections);
      setTruncated(response.truncated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '接続の取得に失敗しました';
      setLoadError(message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections().catch(() => undefined);
  }, [loadConnections]);

  const disconnect = async (connection: Connection) => {
    if (!window.confirm(`「${connection.client_name}」を切断しますか？`))
      return;
    if (removingId) return;
    setRemovingId(connection.id);
    try {
      await removeConnection(connection.id);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : '接続の切断に失敗しました',
      );
      return;
    } finally {
      setRemovingId(null);
    }
    // The revocation already succeeded, so a failed refresh must not read as one.
    onError('接続を切断しました');
    await loadConnections().catch(() => onError('一覧の再取得に失敗しました'));
  };

  return (
    <>
      <header className="detail-header">
        <button
          className="back-button"
          type="button"
          onClick={onBack}
          aria-label="一覧に戻る"
        >
          ‹
        </button>
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>設定</h1>
        </div>
      </header>
      {loading ? (
        <Loading />
      ) : loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => void loadConnections().catch(() => undefined)}
        />
      ) : (
        <>
          {truncated && (
            <p className="notice" role="status">
              接続が多いため、一部だけ表示しています。ここに出ていない接続は切断できません。
            </p>
          )}
          <ConnectionList
            connections={connections}
            removingId={removingId}
            onDisconnect={(connection) => void disconnect(connection)}
          />
        </>
      )}
    </>
  );
}

function ConnectionList({
  connections,
  removingId,
  onDisconnect,
}: {
  connections: Connection[];
  removingId: string | null;
  onDisconnect: (connection: Connection) => void;
}) {
  if (connections.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">◌</div>
        <p>接続中のクライアントはありません</p>
        <small>OAuth クライアントを接続すると、ここに表示されます。</small>
      </div>
    );
  }
  return (
    <section className="connection-list" aria-label="接続中のクライアント一覧">
      {connections.map((connection) => (
        <article className="connection-card" key={connection.id}>
          <div className="connection-main">
            <h2>{connection.client_name}</h2>
            <div className="connection-scopes" aria-label="許可したスコープ">
              {connection.scope.map((scope) => (
                <span className="connection-scope" key={scope}>
                  {scope}
                </span>
              ))}
            </div>
            <p className="connection-created">
              接続日時: {formatConnectionDate(connection.created_at)}
            </p>
          </div>
          <button
            className="button secondary disconnect-button"
            type="button"
            disabled={removingId !== null}
            onClick={() => onDisconnect(connection)}
          >
            {removingId === connection.id ? '切断中…' : '切断'}
          </button>
        </article>
      ))}
    </section>
  );
}

function formatConnectionDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

function TaskDetail({
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

function DraftDialog({
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

interface SpeechResultEvent extends Event {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognizer {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognizer;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}
