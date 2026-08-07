import { describe, expect, it } from 'vitest';
import { normalizeTaskCreateInput, TaskInputError } from './task-input';

const now = new Date('2026-08-03T03:00:00.000Z');

describe('normalizeTaskCreateInput', () => {
  it('gives structured and parsed creation the same defaults', () => {
    const fromText = normalizeTaskCreateInput({ text: '明日 ゴミ出し' }, now);
    const fromTitle = normalizeTaskCreateInput({
      title: 'ゴミ出し',
      due_date: '2026-08-04',
    });

    expect(fromText).toEqual({
      ...fromTitle,
      due_date: '2026-08-04',
    });
    expect(fromText.status).toBe('open');
  });

  it('keeps an explicit status consistent across both input paths', () => {
    expect(
      normalizeTaskCreateInput({ text: 'ゴミ出し', status: 'done' }, now),
    ).toMatchObject({ status: 'done' });
    expect(
      normalizeTaskCreateInput({ title: 'ゴミ出し', status: 'done' }),
    ).toMatchObject({ status: 'done' });
  });

  it('lets explicit fields correct parsed values', () => {
    expect(
      normalizeTaskCreateInput(
        {
          text: '明日 ゴミ出し',
          title: 'ignored when text is present',
          due_date: null,
          priority: 1,
          tags: '家事',
        },
        now,
      ),
    ).toMatchObject({
      title: 'ゴミ出し',
      due_date: null,
      priority: 1,
      tags: '家事',
    });
  });

  it('reports missing creation titles through its adapter-facing error', () => {
    expect(() => normalizeTaskCreateInput({})).toThrow(
      new TaskInputError('title は必須です'),
    );
    expect(() => normalizeTaskCreateInput({ text: '  ' })).toThrow(
      new TaskInputError('text は空にできません'),
    );
  });
});
