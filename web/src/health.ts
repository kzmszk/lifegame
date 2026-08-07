import type { HealthEntry } from '../../src/shared/types';

export function localDateInputValue(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface HealthEntryGroup {
  occurred_on: string;
  entries: HealthEntry[];
}

export function groupHealthEntries(entries: HealthEntry[]): HealthEntryGroup[] {
  const sorted = [...entries].sort((left, right) =>
    left.occurred_on === right.occurred_on
      ? right.id - left.id
      : right.occurred_on.localeCompare(left.occurred_on),
  );
  const groups = new Map<string, HealthEntry[]>();
  for (const entry of sorted) {
    const group = groups.get(entry.occurred_on);
    if (group) group.push(entry);
    else groups.set(entry.occurred_on, [entry]);
  }
  return [...groups].map(([occurred_on, groupedEntries]) => ({
    occurred_on,
    entries: groupedEntries,
  }));
}
