import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys (`pnpm e2e`). Boots a throwaway in-memory API (:4400) and a Vite dev server
 * proxying to it (:5400). Tests share one simulated world (clock, stock), so they run serially.
 */
const API = 'http://localhost:4400';
const WEB = 'http://localhost:5400';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
  webServer: [
    { command: 'pnpm --filter @avero/api e2e:server', url: `${API}/api/v1/health`, timeout: 90_000, reuseExistingServer: false, stdout: 'ignore' },
    {
      command: 'pnpm --filter @avero/web exec vite --port 5400 --strictPort',
      url: WEB,
      env: { AVERO_API_URL: API },
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'ignore',
    },
  ],
});
