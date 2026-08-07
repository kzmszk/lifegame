import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type {
  HealthEntry,
  HealthEntryCreateInput,
  HealthEntriesResponse,
} from '../src/shared/types';

const RUN_ID = randomUUID().slice(0, 8);

function uniqueMarker(label: string): string {
  return `e2e health ${label} ${RUN_ID}`;
}

function formFor(page: Page, heading: string): Locator {
  return page
    .locator('section.health-form-card')
    .filter({
      has: page.getByRole('heading', { name: heading, exact: true }),
    })
    .locator('form');
}

function cardFor(page: Page, marker: string): Locator {
  return page.locator('.health-entry-card').filter({ hasText: marker });
}

async function createHealthEntry(
  request: APIRequestContext,
  input: HealthEntryCreateInput,
): Promise<HealthEntry> {
  const response = await request.post('/api/health-entries', { data: input });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { entry: HealthEntry };
  return body.entry;
}

test.afterEach(async ({ request }) => {
  const response = await request.get('/api/health-entries?limit=100');
  if (!response.ok()) return;
  const { entries } = (await response.json()) as HealthEntriesResponse;
  for (const entry of entries) {
    const marker = entry.kind === 'weight' ? entry.note : entry.activity;
    if (!marker.includes(RUN_ID)) continue;
    const deleted = await request.delete(`/api/health-entries/${entry.id}`);
    expect(deleted.ok()).toBe(true);
  }
});

test('creates, reloads, edits, and deletes grouped health entries', async ({
  page,
}) => {
  const weightMarker = uniqueMarker('weight');
  const exerciseMarker = uniqueMarker('exercise');
  const weightDate = '2026-08-07';
  const exerciseDate = '2026-08-06';

  await page.goto('/health');
  await expect(page.getByRole('heading', { name: '健康' })).toBeVisible();

  const weightForm = formFor(page, '体重測定');
  await weightForm.getByLabel('記録対象日').fill(weightDate);
  await weightForm.getByLabel('体重 (kg)').fill('68.4');
  await weightForm.getByLabel('任意メモ').fill(weightMarker);
  await weightForm.getByRole('button', { name: '体重測定を保存' }).click();

  const exerciseForm = formFor(page, '運動実績');
  await exerciseForm.getByLabel('記録対象日').fill(exerciseDate);
  await exerciseForm.getByLabel('種目名').fill(exerciseMarker);
  await exerciseForm.getByLabel('時間 (分)').fill('30');
  await exerciseForm.getByLabel('任意メモ').fill('記録メモ');
  await exerciseForm.getByRole('button', { name: '運動実績を保存' }).click();

  await expect(cardFor(page, weightMarker)).toContainText('68.4 kg');
  await expect(cardFor(page, exerciseMarker)).toContainText('30分');
  await expect(
    page
      .locator('.health-history-group')
      .filter({ has: page.locator('h3', { hasText: weightDate }) }),
  ).toContainText(weightMarker);
  await expect(
    page
      .locator('.health-history-group')
      .filter({ has: page.locator('h3', { hasText: exerciseDate }) }),
  ).toContainText(exerciseMarker);

  await page.reload();
  await expect(cardFor(page, weightMarker)).toContainText('68.4 kg');
  await expect(cardFor(page, exerciseMarker)).toContainText('30分');

  const weightCard = cardFor(page, weightMarker);
  await weightCard.getByRole('button', { name: '修正' }).click();
  const weightEditor = weightCard.locator('.health-entry-editor');
  await weightEditor.getByLabel('体重 (kg)').fill('69.1');
  await weightEditor.getByLabel('任意メモ').fill(`${weightMarker} edited`);
  await weightEditor.getByRole('button', { name: '変更を保存' }).click();
  await expect(cardFor(page, `${weightMarker} edited`)).toContainText(
    '69.1 kg',
  );

  const exerciseCard = cardFor(page, exerciseMarker);
  await exerciseCard.getByRole('button', { name: '修正' }).click();
  const exerciseEditor = exerciseCard.locator('.health-entry-editor');
  await exerciseEditor.getByLabel('種目名').fill(`${exerciseMarker} edited`);
  await exerciseEditor.getByLabel('時間 (分)').fill('45');
  await exerciseEditor.getByRole('button', { name: '変更を保存' }).click();
  await expect(cardFor(page, `${exerciseMarker} edited`)).toContainText('45分');

  await page.reload();
  await expect(cardFor(page, `${weightMarker} edited`)).toContainText(
    '69.1 kg',
  );
  await expect(cardFor(page, `${exerciseMarker} edited`)).toContainText('45分');

  const editedWeightCard = cardFor(page, `${weightMarker} edited`);
  page.once('dialog', (dialog) => void dialog.accept());
  await editedWeightCard.getByRole('button', { name: '削除' }).click();
  await expect(cardFor(page, `${weightMarker} edited`)).toHaveCount(0);

  const editedExerciseCard = cardFor(page, `${exerciseMarker} edited`);
  page.once('dialog', (dialog) => void dialog.accept());
  await editedExerciseCard.getByRole('button', { name: '削除' }).click();
  await expect(cardFor(page, `${exerciseMarker} edited`)).toHaveCount(0);

  await page.reload();
  await expect(cardFor(page, `${weightMarker} edited`)).toHaveCount(0);
  await expect(cardFor(page, `${exerciseMarker} edited`)).toHaveCount(0);
});

test('loads older health history entries on demand', async ({
  page,
  request,
}) => {
  const marker = uniqueMarker('pagination');
  for (let index = 0; index < 51; index += 1) {
    await createHealthEntry(request, {
      kind: 'weight',
      occurred_on: '2026-08-01',
      weight_kg: 50 + index / 100,
      note: `${marker} ${index}`,
    });
  }

  await page.goto('/health');
  await expect(page.getByRole('heading', { name: '履歴' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'さらに読み込む' }),
  ).toBeVisible();
  await expect(cardFor(page, `${marker} 0`)).toHaveCount(0);

  await page.getByRole('button', { name: 'さらに読み込む' }).click();
  await expect(cardFor(page, `${marker} 0`)).toBeVisible();
});

test('shows a visible health save error from the API', async ({ page }) => {
  await page.route('**/api/health-entries', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: '保存できません' }),
    });
  });

  await page.goto('/health');
  const exerciseForm = formFor(page, '運動実績');
  await exerciseForm.getByLabel('記録対象日').fill('2026-08-07');
  await exerciseForm.getByLabel('種目名').fill(uniqueMarker('error'));
  await exerciseForm.getByRole('button', { name: '運動実績を保存' }).click();

  await expect(exerciseForm.getByRole('alert')).toHaveText('保存できません');
});
