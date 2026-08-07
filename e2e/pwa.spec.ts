import { expect, test } from '@playwright/test';

test('Service Worker がアプリ全体を制御する', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();

  const controller = await page.evaluate(() =>
    navigator.serviceWorker.controller
      ? {
          scriptURL: navigator.serviceWorker.controller.scriptURL,
          state: navigator.serviceWorker.controller.state,
        }
      : null,
  );
  expect(controller).toEqual({
    scriptURL: 'http://127.0.0.1:8787/service-worker.js',
    state: 'activated',
  });
});
