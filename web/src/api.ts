import type {
  CalendarEvent,
  CalendarEventCreateInput,
  CalendarEventResponse,
  CalendarEventsResponse,
  ConnectionsResponse,
  ErrorResponse,
  HealthEntriesResponse,
  HealthEntry,
  HealthEntryCreateInput,
  HealthEntryUpdateInput,
  SavedLink,
  SavedLinkCreateInput,
  SavedLinkCreateResponse,
  SavedLinksResponse,
  SavedLinkUpdateInput,
  SavedLinkView,
  Task,
  TaskCreateInput,
  TaskDraft,
  TasksResponse,
  TaskUpdateInput,
  TaskView,
} from '../../src/shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T | ErrorResponse;
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : `通信に失敗しました (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchTasks(
  view: TaskView,
  offset = 0,
): Promise<TasksResponse> {
  const query = new URLSearchParams({ view, offset: String(offset) });
  return request<TasksResponse>(`/api/tasks?${query}`);
}

export async function fetchTask(id: number): Promise<Task> {
  const response = await request<{ task: Task }>(`/api/tasks/${id}`);
  return response.task;
}

export async function createTask(input: TaskCreateInput): Promise<Task> {
  const response = await request<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.task;
}

export async function parseTask(text: string): Promise<TaskDraft> {
  return request<TaskDraft>('/api/tasks/parse', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export async function updateTask(
  id: number,
  input: TaskUpdateInput,
): Promise<Task> {
  const response = await request<{ task: Task }>(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.task;
}

export async function removeTask(id: number): Promise<void> {
  await request<{ ok: true }>(`/api/tasks/${id}`, { method: 'DELETE' });
}

export async function fetchCalendarEvents(
  date?: string,
): Promise<CalendarEvent[]> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const response = await request<CalendarEventsResponse>(
    `/api/calendar/events${query}`,
  );
  return response.events;
}

export async function createCalendarEvent(
  input: CalendarEventCreateInput,
): Promise<CalendarEvent> {
  const response = await request<CalendarEventResponse>(
    '/api/calendar/events',
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.event;
}

export async function fetchConnections(): Promise<ConnectionsResponse> {
  return request<ConnectionsResponse>('/api/connections');
}

export async function removeConnection(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export interface HealthEntriesQuery {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function fetchHealthEntries(
  options: HealthEntriesQuery = {},
): Promise<HealthEntriesResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<HealthEntriesResponse>(`/api/health-entries${suffix}`);
}

export async function createHealthEntry(
  input: HealthEntryCreateInput,
): Promise<HealthEntry> {
  const response = await request<{ entry: HealthEntry }>(
    '/api/health-entries',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return response.entry;
}

export async function updateHealthEntry(
  id: number,
  input: HealthEntryUpdateInput,
): Promise<HealthEntry> {
  const response = await request<{ entry: HealthEntry }>(
    `/api/health-entries/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return response.entry;
}

export async function deleteHealthEntry(id: number): Promise<void> {
  await request<{ ok: true }>(`/api/health-entries/${id}`, {
    method: 'DELETE',
  });
}

export async function fetchSavedLinks(
  view: SavedLinkView,
  offset = 0,
): Promise<SavedLinksResponse> {
  const query = new URLSearchParams({ view, offset: String(offset) });
  return request<SavedLinksResponse>(`/api/saved-links?${query}`);
}

export async function createSavedLink(
  input: SavedLinkCreateInput,
): Promise<SavedLinkCreateResponse> {
  return request<SavedLinkCreateResponse>('/api/saved-links', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateSavedLink(
  id: number,
  input: SavedLinkUpdateInput,
): Promise<SavedLink> {
  const response = await request<{ link: SavedLink }>(
    `/api/saved-links/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return response.link;
}

export async function deleteSavedLink(id: number): Promise<void> {
  await request<{ ok: true }>(`/api/saved-links/${id}`, {
    method: 'DELETE',
  });
}
