export type TaskStatus = 'open' | 'done';

export type TaskView = 'today' | 'inbox' | 'all';

export interface Task {
  id: number;
  title: string;
  note: string;
  status: TaskStatus;
  due_date: string | null;
  due_time: string | null;
  priority: number;
  tags: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskDraft {
  title: string;
  note: string;
  due_date: string | null;
  due_time: string | null;
  priority: number;
  tags: string;
}

export interface TaskCreateInput {
  text?: string;
  title?: string;
  note?: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: number;
  tags?: string;
  status?: TaskStatus;
}

export interface TaskUpdateInput {
  title?: string;
  note?: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: number;
  tags?: string;
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

export interface TasksResponse {
  tasks: Task[];
}

export interface TaskResponse {
  task: Task;
}

export interface ErrorResponse {
  error: string;
}
