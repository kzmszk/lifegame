import { describe, expect, it } from 'vitest';
import type {
  HealthEntry,
  HealthEntryKind,
  HealthEntryListPage,
} from '../../src/shared/types';
import {
  createHealthHistoryLoader,
  type HealthHistoryState,
} from './health-history-loader';

function entry(id: number, kind: HealthEntryKind): HealthEntry {
  const common = {
    id,
    occurred_on: '2026-08-11',
    note: '',
    created_at: '2026-08-11 00:00:00',
    updated_at: '2026-08-11 00:00:00',
  };
  if (kind === 'weight') return { ...common, kind, weight_kg: 68.4 };
  if (kind === 'exercise')
    return { ...common, kind, activity: '散歩', duration_minutes: 20 };
  return { ...common, kind, duration_minutes: 349 };
}

function page(
  entries: HealthEntry[],
  rest: Partial<HealthEntryListPage> = {},
): HealthEntryListPage {
  return { entries, truncated: false, next_offset: null, ...rest };
}

/** Hands back one deferred promise per call, newest last. */
function deferredFetch() {
  const calls: Array<{
    query: { kind?: HealthEntryKind; offset: number };
    resolve: (page: HealthEntryListPage) => void;
    reject: (error: unknown) => void;
  }> = [];
  const fetchPage = (query: { kind?: HealthEntryKind; offset: number }) =>
    new Promise<HealthEntryListPage>((resolve, reject) => {
      calls.push({ query, resolve, reject });
    });
  return { calls, fetchPage };
}

function track() {
  const seen: HealthHistoryState[] = [];
  return { seen, emit: (state: HealthHistoryState) => seen.push(state) };
}

// Promises resolve on the microtask queue, so the assertions have to run after
// it drains rather than in the same tick as resolve().
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createHealthHistoryLoader', () => {
  it('sends the kind to the fetcher and omits it when unfiltered', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load();
    void loader.load({ kind: 'sleep' });

    expect(calls[0]!.query).toEqual({ offset: 0 });
    expect(calls[1]!.query).toEqual({ kind: 'sleep', offset: 0 });
  });

  // The bug this guards: pick 睡眠 while the initial すべて is still in flight,
  // and the slower first response repaints the list with all three kinds under
  // a filter that says sleep.
  it('ignores a first response that lands after a newer request', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load();
    void loader.load({ kind: 'sleep' });

    calls[1]!.resolve(page([entry(3, 'sleep')]));
    await settle();
    calls[0]!.resolve(page([entry(1, 'weight'), entry(2, 'exercise')]));
    await settle();

    expect(loader.getState().entries.map((e) => e.kind)).toEqual(['sleep']);
    expect(loader.getState().loading).toBe(false);
  });

  // The other half: a page requested under the old filter must not be spliced
  // into the list the new filter produced.
  it('drops a page appended under the previous filter', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load();
    calls[0]!.resolve(
      page([entry(1, 'exercise')], { truncated: true, next_offset: 1 }),
    );
    await settle();

    void loader.load({ offset: 1 });
    void loader.load({ kind: 'sleep' });

    calls[2]!.resolve(page([entry(3, 'sleep')]));
    await settle();
    calls[1]!.resolve(page([entry(2, 'exercise')]));
    await settle();

    expect(loader.getState().entries.map((e) => e.id)).toEqual([3]);
  });

  // An append that was in flight when the filter changed never reports its own
  // completion, so the fresh load has to clear the flag the button reads.
  it('clears a stranded loadingMore when a fresh load starts', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load();
    calls[0]!.resolve(
      page([entry(1, 'exercise')], { truncated: true, next_offset: 1 }),
    );
    await settle();

    void loader.load({ offset: 1 });
    expect(loader.getState().loadingMore).toBe(true);

    void loader.load({ kind: 'sleep' });
    expect(loader.getState().loadingMore).toBe(false);

    calls[1]!.resolve(page([entry(2, 'exercise')]));
    await settle();
    expect(loader.getState().loadingMore).toBe(false);
  });

  it('reports a failure on the half of the screen that asked for it', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load();
    calls[0]!.reject(new Error('取得できません'));
    await settle();
    expect(loader.getState()).toMatchObject({
      loading: false,
      loadError: '取得できません',
      loadMoreError: null,
    });

    void loader.load();
    calls[1]!.resolve(
      page([entry(1, 'exercise')], { truncated: true, next_offset: 1 }),
    );
    await settle();

    void loader.load({ offset: 1 });
    calls[2]!.reject(new Error('続きを読めません'));
    await settle();
    expect(loader.getState()).toMatchObject({
      loadingMore: false,
      loadMoreError: '続きを読めません',
      loadError: null,
      entries: [expect.objectContaining({ id: 1 })],
    });
  });

  it('leaves the state untouched when a stale request fails', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load();
    void loader.load({ kind: 'sleep' });
    calls[1]!.resolve(page([entry(3, 'sleep')]));
    await settle();

    calls[0]!.reject(new Error('遅れて失敗'));
    await settle();

    expect(loader.getState()).toMatchObject({
      loadError: null,
      loading: false,
      entries: [expect.objectContaining({ id: 3 })],
    });
  });

  it('appends within the same filter', async () => {
    const { calls, fetchPage } = deferredFetch();
    const loader = createHealthHistoryLoader(fetchPage, track().emit);

    void loader.load({ kind: 'sleep' });
    calls[0]!.resolve(
      page([entry(1, 'sleep')], { truncated: true, next_offset: 1 }),
    );
    await settle();

    void loader.load({ kind: 'sleep', offset: 1 });
    calls[1]!.resolve(page([entry(2, 'sleep')]));
    await settle();

    expect(loader.getState()).toMatchObject({
      entries: [
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ],
      truncated: false,
      nextOffset: null,
    });
  });
});
