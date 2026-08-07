import type { TaskView } from '../../src/shared/types';
import { parseShareTarget } from './share-target';
import type { SharedLinkDraft } from './share-target';

export type Route =
  | { kind: 'list'; view: TaskView }
  | { kind: 'detail'; id: number; from: TaskView }
  | { kind: 'health' }
  | { kind: 'reading'; shared?: SharedLinkDraft }
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
  if (pathname === '/health') return { kind: 'health' };
  if (pathname === '/reading/share') {
    return {
      kind: 'reading',
      shared: parseShareTarget(new URLSearchParams(search)),
    };
  }
  if (pathname === '/reading') return { kind: 'reading' };
  if (pathname === '/settings') return { kind: 'settings' };
  if (pathname === '/inbox') return { kind: 'list', view: 'inbox' };
  if (pathname === '/all') return { kind: 'list', view: 'all' };
  return { kind: 'list', view: 'today' };
}

export function pathForView(view: TaskView): string {
  return view === 'today' ? '/' : `/${view}`;
}
