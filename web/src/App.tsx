import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  Connection,
  Task,
  TaskDraft,
  TaskStatus,
  TaskView,
} from '../../src/shared/types';
import {
  createTask,
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
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const route = routeForPath(path);
  const listView = route.kind === 'list' ? route.view : null;
  const routeRef = useRef<Route>(route);
  routeRef.current = route;
  const listRequestGeneration = useRef(0);
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

  const handleCreate = useCallback(
    async (text: string) => {
      const task = await createTask({ text });
      const currentRoute = routeRef.current;
      if (currentRoute.kind === 'list') await loadList(currentRoute.view);
      showToast(`「${task.title}」を追加しました`);
    },
    [loadList, showToast],
  );

  const handleVoice = useCallback(async (text: string) => {
    const draft = await parseTask(text);
    setDraft(draft);
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
    async (nextDraft: TaskDraft) => {
      try {
        await createTask(nextDraft);
        setDraft(null);
        const currentRoute = routeRef.current;
        if (currentRoute.kind === 'list') await loadList(currentRoute.view);
        showToast('タスクを追加しました');
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : 'タスクの追加に失敗しました',
        );
      }
    },
    [loadList, showToast],
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
          draft={draft}
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
          task.priority === 1 ||
          task.tags) && (
          <span className="task-meta">
            {task.due_date && (
              <span className="due">
                {task.due_date}
                {task.due_time ? ` ${task.due_time}` : ''}
              </span>
            )}
            {task.priority === 1 && <span className="priority">高</span>}
            {task.tags && <span>{task.tags}</span>}
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
  'title' | 'note' | 'due_date' | 'due_time' | 'priority' | 'tags'
>;

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
        setForm({
          title: loaded.title,
          note: loaded.note,
          due_date: loaded.due_date,
          due_time: loaded.due_time,
          priority: loaded.priority,
          tags: loaded.tags,
        });
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await updateTask(id, { ...form, title: form.title.trim() });
      setTask(saved);
      setForm({
        title: saved.title,
        note: saved.note,
        due_date: saved.due_date,
        due_time: saved.due_time,
        priority: saved.priority,
        tags: saved.tags,
      });
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
        <button className="button primary save-button" disabled={saving}>
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
  onCancel,
  onConfirm,
}: {
  draft: TaskDraft;
  onCancel: () => void;
  onConfirm: (draft: TaskDraft) => Promise<void>;
}) {
  const [value, setValue] = useState(draft);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const set = <K extends keyof TaskDraft>(key: K, next: TaskDraft[K]) =>
    setValue((current) => ({ ...current, [key]: next }));
  const confirm = async () => {
    if (!value.title.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onConfirm(value);
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
            <p className="eyebrow">VOICE DRAFT</p>
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
          音声から読み取った内容です。必要ならここで直せます。
        </p>
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
            <span>期限</span>
            <input
              type="date"
              value={value.due_date ?? ''}
              onChange={(event) => set('due_date', event.target.value || null)}
            />
          </label>
          <label>
            <span>時刻</span>
            <input
              type="time"
              value={value.due_time ?? ''}
              onChange={(event) => set('due_time', event.target.value || null)}
            />
          </label>
        </div>
        <label>
          <span>メモ</span>
          <textarea
            value={value.note}
            onChange={(event) => set('note', event.target.value)}
            rows={3}
          />
        </label>
        <label className="switch-row">
          <span>優先度を上げる</span>
          <input
            type="checkbox"
            checked={value.priority === 1}
            onChange={(event) => set('priority', event.target.checked ? 1 : 0)}
          />
        </label>
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
            disabled={saving || !value.title.trim()}
          >
            {saving ? '追加中…' : 'この内容で追加'}
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
