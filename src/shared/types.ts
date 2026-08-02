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

export interface TasksResponse {
  tasks: Task[];
}

export interface TaskResponse {
  task: Task;
}

export interface ErrorResponse {
  error: string;
}
