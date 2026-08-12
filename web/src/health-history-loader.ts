import type {
  HealthEntry,
  HealthEntryKind,
  HealthEntryListPage,
} from '../../src/shared/types';

/**
 * Everything the history needs in order to render, kept outside React so the
 * one rule that is hard to get right — a response that arrives after a newer
 * request must change nothing — can be tested by resolving promises out of
 * order rather than by driving a component.
 */
export interface HealthHistoryState {
  entries: HealthEntry[];
  truncated: boolean;
  nextOffset: number | null;
  loading: boolean;
  loadingMore: boolean;
  loadError: string | null;
  loadMoreError: string | null;
}

export const INITIAL_HEALTH_HISTORY_STATE: HealthHistoryState = {
  entries: [],
  truncated: false,
  nextOffset: null,
  loading: true,
  loadingMore: false,
  loadError: null,
  loadMoreError: null,
};

export interface HealthHistoryQuery {
  kind?: HealthEntryKind;
  offset?: number;
}

export interface HealthHistoryLoader {
  getState: () => HealthHistoryState;
  load: (query?: HealthHistoryQuery) => Promise<void>;
}

const LOAD_FAILED = '健康記録の取得に失敗しました';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : LOAD_FAILED;
}

/**
 * `fetchPage` is the only I/O. `emit` is called with the whole state whenever it
 * changes, so a React caller can hand it `setState` and hold nothing else.
 *
 * Requests are numbered, and only the newest one may touch the state. Without
 * that, changing the filter starts a second request while the first is still in
 * flight, and whichever finishes last wins: a slow "all" landing after a quick
 * "sleep" puts every kind back on screen under a filter that says sleep. The
 * same applies to a page appended from the previous filter, which would splice
 * the wrong kind into the list.
 */
export function createHealthHistoryLoader(
  fetchPage: (query: {
    kind?: HealthEntryKind;
    offset: number;
  }) => Promise<HealthEntryListPage>,
  emit: (state: HealthHistoryState) => void,
): HealthHistoryLoader {
  let state = INITIAL_HEALTH_HISTORY_STATE;
  let generation = 0;

  function set(patch: Partial<HealthHistoryState>): void {
    state = { ...state, ...patch };
    emit(state);
  }

  async function load(query: HealthHistoryQuery = {}): Promise<void> {
    const offset = query.offset ?? 0;
    const appending = offset > 0;
    const mine = ++generation;

    if (appending) {
      set({ loadingMore: true, loadMoreError: null });
    } else {
      // A fresh load also clears the append flags. An append that was in flight
      // when the filter changed will never report its own completion, and a
      // "読み込み中…" button that nothing can turn off is worse than a lost page.
      set({
        loading: true,
        loadError: null,
        loadingMore: false,
        loadMoreError: null,
      });
    }

    try {
      const page = await fetchPage({
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        offset,
      });
      if (mine !== generation) return;
      set({
        entries: appending ? [...state.entries, ...page.entries] : page.entries,
        truncated: page.truncated,
        nextOffset: page.next_offset,
        ...(appending ? { loadingMore: false } : { loading: false }),
      });
    } catch (caught) {
      if (mine !== generation) return;
      const message = messageOf(caught);
      set(
        appending
          ? { loadingMore: false, loadMoreError: message }
          : { loading: false, loadError: message },
      );
    }
  }

  return { getState: () => state, load };
}
