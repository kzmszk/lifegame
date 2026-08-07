import type { TaskView } from '../../src/shared/types';

export type Route =
  | { kind: 'list'; view: TaskView }
  | { kind: 'detail'; id: number; from: TaskView }
  | { kind: 'settings' };

function isTaskView(value: string | null): value is TaskView {
  return value === 'today' || value === 'inbox' || value === 'all';
}

export function routeForPath(pathWithSearch: string): Route {
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

export function pathForView(view: TaskView): string {
  return view === 'today' ? '/' : `/${view}`;
}
