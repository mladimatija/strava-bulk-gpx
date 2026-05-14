import { defineConfig } from '@playwright/test';

// Two projects: e2e for assertions, screenshots for README capture.
// They share the extension launch fixture but live in separate spec files
// so a CI run does the inexpensive e2e first and only does the (slower) screenshot
// capture when explicitly requested via `npm run test:screenshots`.

export default defineConfig({
	testDir: './tests',
	fullyParallel: false, // Extensions share a persistent Chromium context - keep it serial.
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1, // Single browser context - see above.
	reporter: process.env.CI ? [['list'], ['github']] : 'list',
	use: {
		// Each spec launches its own persistent context with the extension
		// loaded - see tests/fixtures/extension.ts.
		baseURL: 'https://www.strava.com',
		screenshot: 'only-on-failure',
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'e2e',
			testMatch: /tests\/e2e\/.*\.spec\.ts$/,
		},
		{
			name: 'screenshots',
			testMatch: /tests\/screenshots\/.*\.spec\.ts$/,
		},
	],
});
