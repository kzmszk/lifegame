import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CalendarEvent,
  Task,
  TaskDraft,
  TaskStatus,
  TaskView,
} from '../../src/shared/types';
import {
  createCalendarEvent,
  createTask,
  fetchCalendarEvents,
  fetchTasks,
  parseTask,
  updateTask,
} from './api';
import { BottomTabs } from './components/BottomTabs';
import { CalendarEventList } from './components/CalendarEventList';
import { ConnectionSettings } from './components/ConnectionSettings';
import { DraftDialog } from './components/DraftDialog';
import type { DraftKind } from './components/DraftDialog';
import { ErrorState, Loading } from './components/feedback';
import { HealthPage } from './components/HealthPage';
import { QuickAdd } from './components/QuickAdd';
import { ReadingPage } from './components/ReadingPage';
import { TaskDetail } from './components/TaskDetail';
import { TaskList } from './components/TaskList';
import { useToast } from './hooks/useToast';
import { pathForView, routeForPath } from './routing';
import type { Route } from './routing';
import { clearShareTargetQuery } from './share-target';

interface PendingDraft {
  draft: TaskDraft;
  /** Voice drafts get a different hint, since misheard text is the usual worry. */
  source: 'voice' | 'text';
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
  const [tasksTruncated, setTasksTruncated] = useState(false);
  const [nextTaskOffset, setNextTaskOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
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

  useEffect(() => {
    if (path.split('?')[0] === '/reading/share') {
      clearShareTargetQuery(window.history);
    }
  }, [path]);

  const loadList = useCallback(async (view: TaskView, offset = 0) => {
    const generation = ++listRequestGeneration.current;
    const appending = offset > 0;
    if (appending) {
      setLoadingMore(true);
      setLoadMoreError(null);
    } else {
      setLoading(true);
      setLoadError(null);
      setLoadMoreError(null);
    }
    try {
      const response = await fetchTasks(view, offset);
      if (generation !== listRequestGeneration.current) return;
      const currentRoute = routeRef.current;
      if (currentRoute.kind !== 'list' || currentRoute.view !== view) return;
      setTasks((current) =>
        appending ? [...current, ...response.tasks] : response.tasks,
      );
      setTasksTruncated(response.truncated);
      setNextTaskOffset(response.next_offset);
    } catch (error) {
      if (generation !== listRequestGeneration.current) return;
      const message =
        error instanceof Error ? error.message : 'タスクの取得に失敗しました';
      if (appending) setLoadMoreError(message);
      else setLoadError(message);
    } finally {
      if (generation === listRequestGeneration.current) {
        if (appending) setLoadingMore(false);
        else setLoading(false);
      }
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
                truncated={tasksTruncated}
                loadingMore={loadingMore}
                loadMoreError={loadMoreError}
                onLoadMore={() => {
                  if (nextTaskOffset !== null)
                    void loadList(route.view, nextTaskOffset);
                }}
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
        ) : route.kind === 'health' ? (
          <HealthPage onError={showToast} />
        ) : route.kind === 'reading' ? (
          <ReadingPage onError={showToast} initialDraft={route.shared} />
        ) : (
          <ConnectionSettings
            onBack={() => navigate('/')}
            onError={showToast}
          />
        )}
      </main>
      {(route.kind === 'list' ||
        route.kind === 'health' ||
        route.kind === 'reading') && (
        <BottomTabs
          view={
            route.kind === 'health'
              ? 'health'
              : route.kind === 'reading'
                ? 'reading'
                : route.view
          }
        />
      )}
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
