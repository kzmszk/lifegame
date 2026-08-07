import { describe, expect, it } from 'vitest';
import { pathForView, routeForPath } from './routing';

describe('frontend routing helpers', () => {
  it('falls back to today for an unknown path and query string', () => {
    expect(routeForPath('/not-a-route?from=all')).toEqual({
      kind: 'list',
      view: 'today',
    });
  });

  it('recognizes the health entry screen', () => {
    expect(routeForPath('/health')).toEqual({ kind: 'health' });
  });

  it('recognizes the reading list screen', () => {
    expect(routeForPath('/reading')).toEqual({ kind: 'reading' });
  });

  it('turns a Web Share Target request into a reading-list draft', () => {
    expect(
      routeForPath(
        '/reading/share?title=%E5%85%B1%E6%9C%89%E8%A8%98%E4%BA%8B&text=https%3A%2F%2Fexample.com%2Fshared',
      ),
    ).toEqual({
      kind: 'reading',
      shared: { url: 'https://example.com/shared', title: '共有記事' },
    });
  });

  it('reads a valid source view from a task detail query', () => {
    expect(routeForPath('/tasks/42?from=inbox')).toEqual({
      kind: 'detail',
      id: 42,
      from: 'inbox',
    });
  });

  it('uses today when a task detail source view is unknown', () => {
    expect(routeForPath('/tasks/42?from=not-a-view')).toEqual({
      kind: 'detail',
      id: 42,
      from: 'today',
    });
  });

  it.each([
    ['today', '/'],
    ['inbox', '/inbox'],
    ['all', '/all'],
  ] as const)('builds the path for the %s view', (view, path) => {
    expect(pathForView(view)).toBe(path);
  });
});
