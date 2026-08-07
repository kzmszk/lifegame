import type { Task, TaskView } from '../../../src/shared/types';
import { TaskCard } from './TaskCard';

export function TaskList({
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
