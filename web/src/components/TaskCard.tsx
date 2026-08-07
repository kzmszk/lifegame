import type { Task } from '../../../src/shared/types';

export function TaskCard({
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
