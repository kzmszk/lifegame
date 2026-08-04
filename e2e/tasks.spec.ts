import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { Task } from '../src/shared/types';

// The local D1 file persists between runs, so every task carries a unique
// marker and each test removes what it created.
function uniqueTitle(label: string): string {
  return `e2e ${label} ${test.info().testId}`;
}

async function createTask(
  request: APIRequestContext,
  title: string,
): Promise<Task> {
  const response = await request.post('/api/tasks', { data: { title } });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { task: Task };
  return body.task;
}

async function deleteTask(
  request: APIRequestContext,
  id: number,
): Promise<void> {
  await request.delete(`/api/tasks/${id}`);
}

test('a task added from Inbox survives a reload and can be deleted', async ({
  page,
}) => {
  const title = uniqueTitle('quick add');
  await page.goto('/inbox');

  await page.getByRole('textbox', { name: 'タスクを追加' }).fill(title);
  await page.getByRole('button', { name: 'このタスクを追加' }).click();

  const card = page.locator('.task-card', { hasText: title });
  await expect(card).toBeVisible();

  // The point of the e2e pass: prove the task reached D1, not just React state.
  await page.reload();
  await expect(page.locator('.task-card', { hasText: title })).toBeVisible();

  await page
    .locator('.task-card', { hasText: title })
    .locator('.task-main')
    .click();
  await expect(page.getByLabel('タイトル')).toHaveValue(title);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'このタスクを削除' }).click();

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.locator('.task-card', { hasText: title })).toHaveCount(0);
});

test('completing a task takes it out of Inbox', async ({ page, request }) => {
  const title = uniqueTitle('complete');
  const task = await createTask(request, title);

  try {
    await page.goto('/inbox');
    const card = page.locator('.task-card', { hasText: title });
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: '完了にする' }).click();

    // Inbox is open tasks with no due date, so a completed one drops out of it.
    await expect(page.locator('.task-card', { hasText: title })).toHaveCount(0);

    const reread = await request.get(`/api/tasks/${task.id}`);
    expect(((await reread.json()) as { task: Task }).task.status).toBe('done');
  } finally {
    await deleteTask(request, task.id);
  }
});
