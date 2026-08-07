import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { SavedLink, SavedLinksResponse } from '../src/shared/types';

const RUN_ID = randomUUID().slice(0, 8);

function uniqueUrl(label: string): string {
  return `https://example.com/lifegame-e2e/${RUN_ID}/${test.info().retry}/${label}`;
}

function cardFor(page: Page, marker: string) {
  return page.locator('.saved-link-card').filter({ hasText: marker });
}

async function linksIn(
  request: APIRequestContext,
  view: 'reading' | 'archive',
): Promise<SavedLink[]> {
  const response = await request.get(`/api/saved-links?view=${view}&limit=100`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as SavedLinksResponse).links;
}

test.afterEach(async ({ request }) => {
  for (const view of ['reading', 'archive'] as const) {
    for (const link of await linksIn(request, view)) {
      if (!link.url.includes(RUN_ID)) continue;
      const deleted = await request.delete(`/api/saved-links/${link.id}`);
      expect(deleted.ok()).toBe(true);
    }
  }
});

test('保存リンクを作成し、開き、編集、アーカイブ、復帰、削除できる', async ({
  context,
  page,
}) => {
  const url = uniqueUrl('lifecycle');
  const title = `e2e 保存リンク ${RUN_ID}`;
  const editedTitle = `${title} 編集済み`;

  await context.route('https://example.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>保存元ページ</title><h1>保存元ページ</h1>',
    });
  });

  await page.goto('/reading');
  await page.getByLabel('URL').fill(url);
  await page.getByLabel('題名（任意）').fill(title);
  await page.getByLabel('メモ（任意）').fill(`あとで読む ${RUN_ID}`);
  await page.getByRole('button', { name: '読むリストに保存' }).click();

  await expect(page.getByRole('status')).toHaveText(
    `「${title}」を読むリストに保存しました`,
  );
  await expect(cardFor(page, title)).toBeVisible();
  await page.reload();
  const persistedCard = cardFor(page, title);
  await expect(persistedCard).toBeVisible();

  const savedLink = persistedCard.getByRole('link', { name: title });
  await expect(savedLink).toHaveAttribute('href', url);
  await expect(savedLink).toHaveAttribute('target', '_blank');
  await expect(savedLink).toHaveAttribute('rel', 'noopener noreferrer');
  const popupPromise = context.waitForEvent('page');
  await savedLink.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(url);
  await expect(
    popup.getByRole('heading', { name: '保存元ページ' }),
  ).toBeVisible();
  await popup.close();

  await persistedCard.getByRole('button', { name: '編集' }).click();
  const editor = persistedCard.locator('.saved-link-editor');
  await editor.getByLabel('題名').fill(editedTitle);
  await editor.getByLabel('メモ').fill(`読了メモ ${RUN_ID}`);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(cardFor(page, editedTitle)).toContainText(`読了メモ ${RUN_ID}`);

  await cardFor(page, editedTitle)
    .getByRole('button', { name: 'アーカイブ' })
    .click();
  await expect(cardFor(page, editedTitle)).toHaveCount(0);

  await page.getByRole('button', { name: 'アーカイブ', exact: true }).click();
  const archivedCard = cardFor(page, editedTitle);
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole('button', { name: '読むリストへ戻す' }).click();
  await expect(cardFor(page, editedTitle)).toHaveCount(0);

  await page.getByRole('button', { name: '読むリスト', exact: true }).click();
  const restoredCard = cardFor(page, editedTitle);
  await expect(restoredCard).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await restoredCard.getByRole('button', { name: '削除' }).click();
  await expect(cardFor(page, editedTitle)).toHaveCount(0);
  await page.reload();
  await expect(cardFor(page, editedTitle)).toHaveCount(0);
});

test('再保存が既存かアーカイブからの復帰かを通知する', async ({
  page,
  request,
}) => {
  const url = uniqueUrl('outcome');
  const title = `保存結果 ${RUN_ID}`;
  const created = await request.post('/api/saved-links', {
    data: { url, title },
  });
  expect(created.status()).toBe(201);
  const { link } = (await created.json()) as { link: SavedLink };
  const archived = await request.patch(`/api/saved-links/${link.id}`, {
    data: { archived: true },
  });
  expect(archived.ok()).toBe(true);

  await page.goto('/reading');
  await page.getByLabel('URL').fill(url);
  await page.getByRole('button', { name: '読むリストに保存' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'アーカイブから読むリストへ戻しました',
  );

  await page.getByLabel('URL').fill(url);
  await page.getByRole('button', { name: '読むリストに保存' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'すでに読むリストにあります',
  );
});

test('操作エラーを失敗した保存リンクの行に表示する', async ({
  page,
  request,
}) => {
  const failedUrl = uniqueUrl('failed-action');
  const otherUrl = uniqueUrl('other-action');
  const failedTitle = `失敗対象 ${RUN_ID}`;
  const otherTitle = `別のリンク ${RUN_ID}`;
  const failedResponse = await request.post('/api/saved-links', {
    data: { url: failedUrl, title: failedTitle },
  });
  const otherResponse = await request.post('/api/saved-links', {
    data: { url: otherUrl, title: otherTitle },
  });
  const failed = (await failedResponse.json()) as { link: SavedLink };
  expect(otherResponse.status()).toBe(201);

  await page.route(`**/api/saved-links/${failed.link.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: '試験用の失敗' }),
    });
  });

  await page.goto('/reading');
  const failedCard = cardFor(page, failedTitle);
  const otherCard = cardFor(page, otherTitle);
  await failedCard.getByRole('button', { name: 'アーカイブ' }).click();

  await expect(failedCard.getByRole('alert')).toHaveText('試験用の失敗');
  await expect(otherCard.getByRole('alert')).toHaveCount(0);
  await expect(
    failedCard.getByRole('button', { name: 'アーカイブ' }),
  ).toBeEnabled();
});

test('Android 共有 URL は保存せず確認フォームへ引き渡す', async ({
  page,
  request,
}) => {
  const url = uniqueUrl('share-target');
  const title = `共有記事 ${RUN_ID}`;

  await page.goto(
    `/reading/share?title=${encodeURIComponent(title)}&text=${encodeURIComponent(`紹介文 ${url}`)}`,
  );

  await expect(page).toHaveURL(/\/reading$/);
  await expect(page.getByLabel('URL')).toHaveValue(url);
  await expect(page.getByLabel('題名（任意）')).toHaveValue(title);
  await expect(
    page.getByRole('button', { name: '読むリストに保存' }),
  ).toBeEnabled();

  const links = [
    ...(await linksIn(request, 'reading')),
    ...(await linksIn(request, 'archive')),
  ];
  expect(links.some((link) => link.url === url)).toBe(false);
});

test('幅 320px でも読む画面と 5 タブが横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/reading');

  const navigation = page.getByRole('navigation', {
    name: 'メインナビゲーション',
  });
  await expect(navigation.getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('heading', { name: '読むリスト' })).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await navigation.evaluate(
      (element) => element.getBoundingClientRect().right <= window.innerWidth,
    ),
  ).toBe(true);
});
