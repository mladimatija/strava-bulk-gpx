// Shared Playwright fixture that boots a Chromium instance with the built
// extension loaded as unpacked. Also serves the static fixture HTML for the
// Strava My Activities URL so the content script can match its declared
// pattern (https://www.strava.com/athlete/training*) without us needing a
// real Strava account.
//
// Usage in a spec file:
//
//   import { test, expect } from '../fixtures/extension.ts';
//   test('toolbar mounts', async ({ extensionPage }) => { ... });

import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const distDir = path.join(repoRoot, 'dist');
const fixtureHtml = path.join(__dirname, 'strava-training.html');

if (!existsSync(distDir)) {
	throw new Error(`dist/ not found at ${distDir}. Run \`npm run build\` before \`npm test\`.`);
}

interface Fixtures {
	context: BrowserContext;
	extensionPage: Page;
}

export const test = base.extend<Fixtures>({
	// Persistent context with the unpacked extension.
	//
	// We deliberately run with `headless: false` because:
	//   1. Playwright's `headless: true` pins Chromium's *old* headless mode,
	//      which doesn't load extensions at all - `--load-extension` is silently
	//      ignored and no content script ever runs.
	//   2. Chrome 137+ disabled `--load-extension` even in non-headless unless
	//      `DisableLoadExtensionCommandLineSwitch` is re-enabled via the flag
	//      below. Skip that flag and the extension never registers.
	//
	// By default, we use Playwright's bundled Chromium (reproducible across
	// environments). Set `PWTEST_BROWSER=chrome` to use your installed Chrome
	// stable instead - useful for testing against the exact browser the
	// extension will ship in. Same flag set, different binary.
	//
	// For CI: wrap the test command in `xvfb-run --auto-servernum npm test`
	// so Linux gets a virtual display. See .github/workflows/ci.yml.
	context: async ({ headless: _headless }, use) => {
		const useSystemChrome = process.env.PWTEST_BROWSER === 'chrome';
		const context = await chromium.launchPersistentContext('', {
			headless: false,
			...(useSystemChrome ? { channel: 'chrome' } : {}),
			// Force the browser UI language to English so chrome.i18n.getMessage
			// resolves the en/messages.json strings regardless of which locale
			// the developer's OS is set to. Without this, a contributor on a
			// German Chrome would see the de/messages.json strings and the
			// e2e assertions for "Download selected" etc. would fail.
			locale: 'en-US',
			args: [
				`--disable-extensions-except=${distDir}`,
				`--load-extension=${distDir}`,
				'--lang=en-US',
				// Required on Chrome >=137 - re-enables --load-extension which is
				// gated behind a feature flag in recent Chromium versions.
				'--disable-features=DisableLoadExtensionCommandLineSwitch',
				// Required on some CI runners (Linux containers without a sandbox).
				'--no-sandbox',
			],
		});
		await use(context);
		await context.close();
	},

	// A page that has the Strava fixture loaded and the content script
	// active. Tests typically just use this and assert the toolbar / row state.
	extensionPage: async ({ context }, use) => {
		const html = readFileSync(fixtureHtml, 'utf8');
		const page = context.pages()[0] ?? (await context.newPage());

		// Intercept the navigation so Chrome sees a strava.com URL (which
		// triggers the content_scripts match) while we serve the static
		// fixture. This avoids needing real Strava credentials.
		await page.route('https://www.strava.com/athlete/training*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: html,
			});
		});

		await page.goto('https://www.strava.com/athlete/training');
		// Wait for our content script to mount the toolbar - the signal that
		// the extension picked up and ran on the page.
		await page.waitForSelector('.sbgx-toolbar', { timeout: 5000 });

		await use(page);
	},
});

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';
