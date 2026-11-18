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
import { test, type Page } from '../fixtures/extension.ts';
import { fakeRowsHtml, installFakePager, type FakeRow } from '../fixtures/pages.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readmeDir = path.resolve(__dirname, '../../docs/screenshots');
const storeDir = path.resolve(__dirname, '../../docs/store');

// Chrome Web Store accepts either 1280×800 or 640×400 PNG/JPEG. 1280×800
// reads well at the listing's "Screenshots" carousel size.
const STORE_VIEWPORT = { width: 1280, height: 800 } as const;

/** More pages of the fixture's list, for "Select all pages". */
const MORE_ROWS: FakeRow[][] = [
	[
		{ id: '9000000011', sport: 'Ride', title: 'Gravel Loop' },
		{ id: '9000000012', sport: 'Hike', title: 'Ridge Hike' },
		{ id: '9000000013', sport: 'Run', title: 'Easy Run' },
	],
	[
		{ id: '9000000021', sport: 'Run', title: 'Track Session' },
		{ id: '9000000022', sport: 'Workout', title: 'Core', distance: '0 km' },
	],
];

/**
 * Start "Select all pages" over a slow fake pager, and wait until it's on
 * its second page, so the progress status is on screen.
 */
async function startSelectingPages(page: Page): Promise<void> {
	await installFakePager(page, ['', ...MORE_ROWS.map(fakeRowsHtml)], 0, {
		delayMs: 4000,
		total: 3184,
		removeTable: false,
	});
	await page.locator('[data-role="select-pages"]').click();
	await page.locator('[data-role="status-text"]').filter({ hasText: '21-40 of 3184' }).waitFor({ timeout: 10_000 });
}

/** Original mode with the fixture's indoor rows selected next to an outdoor one. */
async function selectIndoorRows(page: Page): Promise<void> {
	await page.locator('select[data-role="format"]').selectOption('original');
	await page.locator('tr[data-sbgx-has-gps="0"] .sbgx-row-cb').nth(0).check();
	await page.locator('tr[data-sbgx-has-gps="0"] .sbgx-row-cb').nth(1).check();
	await page.locator('.sbgx-row-cb').nth(0).check();
}

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

	test('all pages - selecting across pages, mid-walk', async ({ extensionPage }) => {
		await startSelectingPages(extensionPage);
		await extensionPage.locator('.sbgx-toolbar').screenshot({ path: path.join(readmeDir, 'all-pages.png') });
	});

	test('original - indoor activities selectable in Original mode', async ({ extensionPage }) => {
		await selectIndoorRows(extensionPage);
		await extensionPage.locator('table').screenshot({ path: path.join(readmeDir, 'original-indoor.png') });
	});

	test('menu - the ⋯ menu open', async ({ extensionPage }) => {
		await extensionPage.locator('[data-role="more"] > summary').click();
		await extensionPage.locator('select[data-role="trim"]').selectOption('custom');
		await extensionPage.locator('[data-role="trim-value"]').fill('700');
		const toolbar = (await extensionPage.locator('.sbgx-toolbar').boundingBox())!;
		const menu = (await extensionPage.locator('.sbgx-menu').boundingBox())!;
		// The menu hangs below the toolbar; take both, padded a little.
		const x = Math.min(toolbar.x, menu.x) - 8;
		const y = toolbar.y - 8;
		await extensionPage.screenshot({
			path: path.join(readmeDir, 'menu.png'),
			clip: {
				x,
				y,
				width: Math.max(toolbar.x + toolbar.width, menu.x + menu.width) + 8 - x,
				height: menu.y + menu.height + 8 - y,
			},
		});
	});
});

// Five 1280×800 full-page shots (the store's maximum) that map to the shot list in
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

	test('2-original-indoor - Original mode, indoor activities selected', async ({ extensionPage }) => {
		// Original mode is the one that exports indoor activities - the
		// uploaded file, with its heart rate and power.
		await selectIndoorRows(extensionPage);
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-2-original-indoor.png'),
			fullPage: false,
		});
	});

	test('3-select-all-pages - selecting across pages, mid-walk', async ({ extensionPage }) => {
		await startSelectingPages(extensionPage);
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-3-all-pages.png'),
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
