// Playwright config for this tool. Run locally with:
//   npm i -D @playwright/test && npx playwright install chromium && npx playwright test
// (the factory runs the same tests headless before every publish)
const port = process.env.PORT || '4173';
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${port}/`;

module.exports = {
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.PW_JSON ? [['list'], ['json', { outputFile: process.env.PW_JSON }]] : 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    serviceWorkers: 'allow',
    trace: 'off',
  },
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 20_000,
  },
};
