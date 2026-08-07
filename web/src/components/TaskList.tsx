import type { Task, TaskView } from '../../../src/shared/types';
import { TaskCard } from './TaskCard';

export function TaskList({
  tasks,
  view,
  truncated,
  loadingMore,
  loadMoreError,
  onLoadMore,
  updatingTaskIds,
  onToggle,
  onOpen,
}: {
  tasks: Task[];
  view: TaskView;
  truncated: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
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
    <>
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
      {truncated && (
        <div className="task-list-more" aria-live="polite">
          <p>表示件数の上限に達しています。</p>
          {loadMoreError && <p role="alert">{loadMoreError}</p>}
          <button type="button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? '読み込み中…' : 'さらに読み込む'}
          </button>
        </div>
      )}
    </>
  );
}
