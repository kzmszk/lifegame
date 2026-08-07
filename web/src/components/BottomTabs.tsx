import type { TaskView } from '../../../src/shared/types';
import { pathForView } from '../routing';

const viewTitles: Record<TaskView, string> = {
  today: '今日',
  inbox: 'Inbox',
  all: '一覧',
};

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function BottomTabs({ view }: { view: TaskView }) {
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
