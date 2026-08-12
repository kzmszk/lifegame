import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ExerciseSession,
  HealthEntry,
  SleepRecord,
  WeightMeasurement,
} from '../../../src/shared/types';
import { groupHealthEntries, localDateInputValue } from '../health';
import { BottomTabs } from './BottomTabs';
import { HealthEntryForm, HealthHistory } from './HealthPage';

const weight: WeightMeasurement = {
  id: 2,
  kind: 'weight',
  occurred_on: '2026-08-07',
  weight_kg: 68.4,
  note: '朝',
  created_at: '2026-08-07 00:00:00',
  updated_at: '2026-08-07 00:00:00',
};

const exercise: ExerciseSession = {
  id: 1,
  kind: 'exercise',
  occurred_on: '2026-08-06',
  activity: '散歩',
  duration_minutes: 30,
  note: '',
  created_at: '2026-08-06 00:00:00',
  updated_at: '2026-08-06 00:00:00',
};

const sleep: SleepRecord = {
  id: 3,
  kind: 'sleep',
  occurred_on: '2026-08-11',
  duration_minutes: 445,
  note: '',
  created_at: '2026-08-11 00:00:00',
  updated_at: '2026-08-11 00:00:00',
};

describe('health entry components', () => {
  it('uses the browser local calendar date for new forms', () => {
    expect(localDateInputValue(new Date(2026, 7, 7, 23, 30))).toBe(
      '2026-08-07',
    );
  });

  it('orders date groups and same-day entries independently of input order', () => {
    expect(groupHealthEntries([weight, exercise])).toEqual([
      { occurred_on: '2026-08-07', entries: [weight] },
      { occurred_on: '2026-08-06', entries: [exercise] },
    ]);
  });

  it('shows the documented fields for each separate health entry form', () => {
    const html = renderToStaticMarkup(
      <>
        <HealthEntryForm kind="weight" onSaved={() => Promise.resolve()} />
        <HealthEntryForm kind="exercise" onSaved={() => Promise.resolve()} />
      </>,
    );

    expect(html).toContain('体重測定');
    expect(html).toContain('運動実績');
    expect(html.match(/記録対象日/g)).toHaveLength(2);
    expect(html).toContain('体重 (kg)');
    expect(html).toContain('種目名');
    expect(html).toContain('時間 (分)');
    expect(html).toContain('任意メモ');
  });

  it('exposes the health screen from the shared bottom navigation', () => {
    const html = renderToStaticMarkup(<BottomTabs view="health" />);

    expect(html).toContain('健康');
    expect(html).toContain('class="active"');
  });

  it('groups history by occurrence date and provides correction and deletion controls', () => {
    const entries: HealthEntry[] = [weight, exercise];
    const html = renderToStaticMarkup(
      <HealthHistory
        entries={entries}
        truncated
        loadingMore={false}
        loadMoreError={null}
        onLoadMore={() => undefined}
        onUpdated={() => Promise.resolve()}
        onDeleted={() => Promise.resolve()}
      />,
    );

    expect(html).toContain('2026-08-07');
    expect(html).toContain('2026-08-06');
    expect(html).toContain('68.4 kg');
    expect(html).toContain('散歩');
    expect(html).toContain('修正');
    expect(html).toContain('削除');
    expect(html).toContain('さらに読み込む');
  });

  // Sleep arrives only from the companion's sync and has no form to edit it back
  // through, so the history shows it in hours and offers deletion but not
  // correction. 445 minutes reads as 7時間25分, not as 445.
  it('shows a sleep session in hours and offers no correction button', () => {
    const html = renderToStaticMarkup(
      <HealthHistory
        entries={[sleep]}
        truncated={false}
        loadingMore={false}
        loadMoreError={null}
        onLoadMore={() => undefined}
        onUpdated={() => Promise.resolve()}
        onDeleted={() => Promise.resolve()}
      />,
    );

    expect(html).toContain('睡眠実績');
    expect(html).toContain('7時間25分');
    expect(html).not.toContain('445');
    expect(html).not.toContain('修正');
    expect(html).toContain('削除');
  });
});
