import type { RepeatRule } from '../lib/repeat';

export type TaskStatus = 'open' | 'done';

export type TaskView = 'today' | 'inbox' | 'all';

/** The maximum number of tasks returned by one list page. */
export const DEFAULT_TASK_LIST_LIMIT = 100;
export const MAX_TASK_LIST_LIMIT = 100;

export interface Task {
  id: number;
  title: string;
  note: string;
  status: TaskStatus;
  due_date: string | null;
  due_time: string | null;
  /** When to perform this occurrence. This is distinct from a deadline. */
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: number;
  tags: string;
  repeat_rule: RepeatRule | null;
  repeat_child_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskDraft {
  title: string;
  note: string;
  due_date: string | null;
  due_time: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: number;
  tags: string;
  repeat_rule: RepeatRule | null;
}

export interface TaskCreateInput {
  text?: string;
  title?: string;
  note?: string;
  due_date?: string | null;
  due_time?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  priority?: number;
  tags?: string;
  repeat_rule?: RepeatRule | null;
  status?: TaskStatus;
}

export interface TaskUpdateInput {
  title?: string;
  note?: string;
  due_date?: string | null;
  due_time?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  priority?: number;
  tags?: string;
  repeat_rule?: RepeatRule | null;
  status?: TaskStatus;
}

/**
 * A Google Calendar event, flattened for display. `start`/`end` keep the raw
 * boundaries ('YYYY-MM-DD' for all-day events, RFC 3339 otherwise); the `_time`
 * fields are the Tokyo wall-clock rendering and are null for all-day events.
 */
export interface CalendarEvent {
  id: string;
  title: string;
  all_day: boolean;
  start: string;
  end: string;
  start_time: string | null;
  end_time: string | null;
  /**
   * The event began before the requested day and is already under way. Rendering
   * `start_time` on its own would announce it as starting tonight.
   */
  started_earlier: boolean;
  /** The event runs past the end of the requested day. */
  ends_later: boolean;
  location: string | null;
  note: string;
  html_link: string;
}

export interface CalendarEventCreateInput {
  title: string;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM' */
  start_time: string;
  /** 'HH:MM'. Defaults to one hour after the start. */
  end_time?: string | null;
  note?: string;
}

export interface CalendarEventsResponse {
  date: string;
  events: CalendarEvent[];
}

export interface CalendarEventResponse {
  event: CalendarEvent;
}

export interface Connection {
  id: string;
  client_id: string;
  client_name: string;
  scope: string[];
  created_at: number;
}

export interface ConnectionsResponse {
  connections: Connection[];
  /** True when the page budget ran out, so this list is partial. */
  truncated: boolean;
}

export interface TaskListPage {
  tasks: Task[];
  /** True when more tasks exist after this page. */
  truncated: boolean;
  /** Offset to use for the next request, or null when this is the last page. */
  next_offset: number | null;
}

export type TasksResponse = TaskListPage;

export interface TaskResponse {
  task: Task;
}

export interface WeightMeasurement {
  id: number;
  kind: 'weight';
  occurred_on: string;
  weight_kg: number;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface ExerciseSession {
  id: number;
  kind: 'exercise';
  occurred_on: string;
  activity: string;
  duration_minutes: number | null;
  note: string;
  created_at: string;
  updated_at: string;
}

/**
 * One sleep session, only ever produced by the companion's sync. `occurred_on`
 * is the local date the session ended, so a night belongs to the morning it was
 * slept into rather than splitting on whether bedtime fell before midnight.
 * `duration_minutes` is required, unlike an exercise session's: a sleep record
 * without a length carries nothing.
 */
export interface SleepRecord {
  id: number;
  kind: 'sleep';
  occurred_on: string;
  duration_minutes: number;
  note: string;
  created_at: string;
  updated_at: string;
}

export type HealthEntry = WeightMeasurement | ExerciseSession | SleepRecord;

export interface WeightMeasurementInput {
  kind: 'weight';
  occurred_on: string;
  weight_kg: number;
  note?: string;
}

export interface ExerciseSessionInput {
  kind: 'exercise';
  occurred_on: string;
  activity: string;
  duration_minutes?: number | null;
  note?: string;
}

export type HealthEntryInput = WeightMeasurementInput | ExerciseSessionInput;
export type HealthEntryCreateInput = HealthEntryInput;

export interface WeightMeasurementUpdateInput {
  kind: 'weight';
  occurred_on?: string;
  weight_kg?: number;
  note?: string;
}

export interface ExerciseSessionUpdateInput {
  kind: 'exercise';
  occurred_on?: string;
  activity?: string;
  duration_minutes?: number | null;
  note?: string;
}

export type HealthEntryUpdateInput =
  | WeightMeasurementUpdateInput
  | ExerciseSessionUpdateInput;

export interface HealthEntryListPage {
  entries: HealthEntry[];
  /** True when more health entries exist after this page. */
  truncated: boolean;
  /** Offset to use for the next request, or null when this is the last page. */
  next_offset: number | null;
}

export type HealthEntriesResponse = HealthEntryListPage;

export interface HealthEntryResponse {
  entry: HealthEntry;
}

export type SavedLinkView = 'reading' | 'archive';
export type SavedLinkCreateOutcome = 'created' | 'existing' | 'restored';

export interface SavedLink {
  id: number;
  url: string;
  title: string;
  note: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedLinkCreateInput {
  url: string;
  title?: string;
  note?: string;
}

export interface SavedLinkUpdateInput {
  title?: string;
  note?: string;
  archived?: boolean;
}

export interface SavedLinkListPage {
  links: SavedLink[];
  truncated: boolean;
  next_offset: number | null;
}

export type SavedLinksResponse = SavedLinkListPage;

export interface SavedLinkResponse {
  link: SavedLink;
}

export interface SavedLinkCreateResponse extends SavedLinkResponse {
  outcome: SavedLinkCreateOutcome;
}

export interface ErrorResponse {
  error: string;
}
