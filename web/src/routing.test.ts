import { describe, expect, it } from 'vitest';
import { pathForView, routeForPath } from './routing';

describe('frontend routing helpers', () => {
  it('falls back to today for an unknown path and query string', () => {
    expect(routeForPath('/not-a-route?from=all')).toEqual({
      kind: 'list',
      view: 'today',
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
