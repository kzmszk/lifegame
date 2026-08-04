import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;
const baseURL = `http://127.0.0.1:${PORT}`;
// wrangler dev takes the request host from the custom domain in `routes`, so the
// worker sees lifegame.tachicoma.com unless e2e:server passes --host. That host
// reaches the consent page as the form action, and `form-action 'self'` then
// blocks the approval on an origin mismatch. Keep --host in step with baseURL,
// port included: --host 127.0.0.1 alone resolves to port 80 and still mismatches.

export default defineConfig({
  testDir: './e2e',
  // The suite shares one local D1 file, so parallel workers would see each
  // other's tasks in the list views.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      // The app is phone-shaped: the bottom tabs and quick-add assume it.
      use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run e2e:server',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // Cold start runs the vite build before wrangler boots the worker.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
