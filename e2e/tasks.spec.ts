import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { Task } from '../src/shared/types';

// The local D1 file outlives a run, so titles carry a marker that is unique per
// process. testId alone is stable across runs and retries: a run that died
// before its cleanup would hand the next attempt a second task with the same
// title, and the strict-mode locators below would then match both.
const RUN_ID = randomUUID().slice(0, 8);

function uniqueTitle(label: string): string {
  return `e2e ${label} ${RUN_ID}.${test.info().retry}`;
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

// Runs whatever the test did or failed to do, including for tasks this file
// created through the UI and never learned the id of.
test.afterEach(async ({ request }) => {
  const response = await request.get('/api/tasks?view=all');
  if (!response.ok()) return;
  const { tasks } = (await response.json()) as { tasks: Task[] };
  for (const task of tasks) {
    if (task.title.includes(RUN_ID)) {
      await request.delete(`/api/tasks/${task.id}`);
    }
  }
});

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

  await page.goto('/inbox');
  const card = page.locator('.task-card', { hasText: title });
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: '完了にする' }).click();

  // Inbox is open tasks with no due date, so a completed one drops out of it.
  await expect(page.locator('.task-card', { hasText: title })).toHaveCount(0);

  const reread = await request.get(`/api/tasks/${task.id}`);
  expect(((await reread.json()) as { task: Task }).task.status).toBe('done');
});

test('a recurring task created in the UI generates and persists its next occurrence', async ({
  page,
  request,
}) => {
  const title = uniqueTitle('daily repeat');
  await page.goto('/');

  await page
    .getByRole('textbox', { name: 'タスクを追加' })
    .fill(`毎日 ${title}`);
  await page.getByRole('button', { name: 'このタスクを追加' }).click();

  const dialog = page.getByRole('dialog', { name: '内容を確認' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('繰り返しの頻度')).toHaveValue('daily');
  await dialog.getByRole('button', { name: 'この内容で追加' }).click();

  const currentCard = page.locator('.task-card', { hasText: title });
  await expect(currentCard).toBeVisible();
  await expect(currentCard.getByLabel('繰り返しタスク')).toBeVisible();
  await currentCard.getByRole('button', { name: '完了にする' }).click();

  // Reload before checking the list so the generated task must come from D1,
  // not from React state left behind by the completion request.
  await page.reload();
  await page.goto('/all');

  const recurringCards = page.locator('.task-card', { hasText: title });
  await expect(recurringCards).toHaveCount(2);
  const nextCard = recurringCards.filter({
    has: page.getByRole('button', { name: '完了にする' }),
  });
  await expect(nextCard).toHaveCount(1);
  await expect(nextCard.getByLabel('繰り返しタスク')).toBeVisible();

  const response = await request.get('/api/tasks?view=all');
  expect(response.ok()).toBeTruthy();
  const { tasks } = (await response.json()) as { tasks: Task[] };
  const occurrences = tasks.filter((task) => task.title === title);
  expect(occurrences).toHaveLength(2);
  const completed = occurrences.find((task) => task.status === 'done');
  const next = occurrences.find((task) => task.status === 'open');
  expect(completed?.repeat_rule).toBeNull();
  expect(next?.repeat_rule).toBe('daily');
  expect(completed?.repeat_child_id).toBe(next?.id);
  expect(next?.due_date).not.toBe(completed?.due_date);
});
