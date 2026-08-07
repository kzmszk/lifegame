import type { TaskView } from '../../../src/shared/types';
import { pathForView } from '../routing';

export type BottomTab = TaskView | 'health';

const viewTitles: Record<BottomTab, string> = {
  today: '今日',
  inbox: 'Inbox',
  all: '一覧',
  health: '健康',
};

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function BottomTabs({ view }: { view: BottomTab }) {
  const tabs: BottomTab[] = ['today', 'inbox', 'all', 'health'];
  return (
    <nav className="bottom-tabs" aria-label="メインナビゲーション">
      {tabs.map((item) => (
        <button
          key={item}
          type="button"
          className={view === item ? 'active' : ''}
          onClick={() =>
            navigate(item === 'health' ? '/health' : pathForView(item))
          }
        >
          <span className="tab-icon">
            {item === 'today'
              ? '◷'
              : item === 'inbox'
                ? '□'
                : item === 'all'
                  ? '☷'
                  : '♡'}
          </span>
          <span>{viewTitles[item]}</span>
        </button>
      ))}
    </nav>
  );
}
