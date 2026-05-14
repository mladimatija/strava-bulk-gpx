// Generates two sets of screenshots from the same fixture the e2e tests use:
//
//   1. README screenshots (tight bounding-box crops of the toolbar / row /
//      bulk progress state) → docs/screenshots/.
//   2. Chrome Web Store listing screenshots (full-viewport 1280×800 PNGs) →
//      docs/store/.
//
// Run with `npm run test:screenshots`. The `pretest:screenshots` script
// runs `npm run build` first, so the fixture loads the latest extension code.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '../fixtures/extension.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readmeDir = path.resolve(__dirname, '../../docs/screenshots');
const storeDir = path.resolve(__dirname, '../../docs/store');

// Chrome Web Store accepts either 1280×800 or 640×400 PNG/JPEG. 1280×800
// reads well at the listing's "Screenshots" carousel size.
const STORE_VIEWPORT = { width: 1280, height: 800 } as const;

test.describe('README screenshots', () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test('toolbar - idle, 0 selected', async ({ extensionPage }) => {
		const toolbar = extensionPage.locator('.sbgx-toolbar');
		await toolbar.screenshot({ path: path.join(readmeDir, 'toolbar.png') });
	});

	test('per-row - checkbox + GPX button on a GPS-bearing row', async ({ extensionPage }) => {
		const row = extensionPage.locator('tr[data-sbgx-has-gps="1"]').first();
		await row.scrollIntoViewIfNeeded();
		await row.screenshot({ path: path.join(readmeDir, 'per-row.png') });
	});

	test('bulk - mid-download with spinner visible', async ({ extensionPage }) => {
		// Slow every export_gpx response down so the spinner state lingers
		// long enough to capture. Without this delay the terminal "Saved N
		// activities." state would arrive instantly.
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			await new Promise((r) => setTimeout(r, 1500));
			await route.fulfill({
				status: 200,
				contentType: 'application/gpx+xml',
				body: '<?xml version="1.0"?><gpx></gpx>',
			});
		});

		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();

		await extensionPage.locator('.sbgx-spinner:not([hidden])').waitFor({ state: 'visible' });
		await extensionPage.waitForTimeout(100);

		await extensionPage.locator('.sbgx-toolbar').screenshot({
			path: path.join(readmeDir, 'bulk.png'),
		});
	});
});

// Five 1280×800 full-page shots that map to the suggested shot list in
// docs/CHROME_WEB_STORE.md. The Strava fixture is generic enough that
// these read like a real My Activities page minus the chrome around it.
test.describe('Chrome Web Store listing screenshots', () => {
	test.use({ viewport: STORE_VIEWPORT });

	test('1-toolbar-idle - default GPX mode, nothing selected', async ({ extensionPage }) => {
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-1-toolbar.png'),
			fullPage: false,
		});
	});

	test('2-format-dropdown - dropdown open showing GPX / TCX / Original', async ({ extensionPage }) => {
		// Native <select> dropdowns can't be screenshotted in their open
		// state on most platforms (the popup is OS-rendered, not part of
		// the page). Instead, we tick a few rows and switch the format to TCX,
		// so the per-row buttons re-label live and the dropdown's current
		// value visibly says "TCX" - which is what the shot demonstrates.
		await extensionPage.locator('.sbgx-row-cb').nth(0).check();
		await extensionPage.locator('.sbgx-row-cb').nth(1).check();
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-2-format-tcx.png'),
			fullPage: false,
		});
	});

	test('3-merge-mid-flight - merging into one GPX with spinner', async ({ extensionPage }) => {
		// Slow each export_gpx so the "Merging into one GPX…" status text
		// is on screen when the screenshot fires.
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			await new Promise((r) => setTimeout(r, 1500));
			await route.fulfill({
				status: 200,
				contentType: 'application/gpx+xml',
				body: '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>demo</name><trkseg><trkpt lat="45" lon="13"/></trkseg></trk></gpx>',
			});
		});
		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="merge"]').click();
		await extensionPage.locator('.sbgx-spinner:not([hidden])').waitFor({ state: 'visible' });
		await extensionPage.waitForTimeout(100);
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-3-merge.png'),
			fullPage: false,
		});
	});

	test('4-bulk-mid-flight - downloading 3 / 5 with spinner', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			await new Promise((r) => setTimeout(r, 1500));
			await route.fulfill({
				status: 200,
				contentType: 'application/gpx+xml',
				body: '<?xml version="1.0"?><gpx></gpx>',
			});
		});
		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		await extensionPage.locator('.sbgx-spinner:not([hidden])').waitFor({ state: 'visible' });
		await extensionPage.waitForTimeout(100);
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-4-bulk.png'),
			fullPage: false,
		});
	});

	test('5-bulk-success - terminal "Saved N activities" state', async ({ extensionPage }) => {
		// Fast-fulfill the route so the run completes quickly, and we land
		// in the terminal success state.
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/gpx+xml',
				body: '<?xml version="1.0"?><gpx></gpx>',
			});
		});
		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		// Wait for the success status text to land (status kind = 'ok').
		await extensionPage
			.locator('[data-role="status"][data-kind="ok"] [data-role="status-text"]')
			.waitFor({ state: 'visible' });
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-5-success.png'),
			fullPage: false,
		});
	});
});
