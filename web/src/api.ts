import type {
  ConnectionsResponse,
  ErrorResponse,
  Task,
  TaskCreateInput,
  TaskDraft,
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

export async function fetchTasks(view: TaskView): Promise<Task[]> {
  const response = await request<{ tasks: Task[] }>(`/api/tasks?view=${view}`);
  return response.tasks;
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

export async function fetchConnections(): Promise<ConnectionsResponse> {
  return request<ConnectionsResponse>('/api/connections');
}

export async function removeConnection(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
