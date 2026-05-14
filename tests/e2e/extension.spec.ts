// E2E behavior tests. Each test starts from a fresh fixture page with the
// content script already mounted (see tests/fixtures/extension.ts).

import { test, expect, type Page } from '../fixtures/extension.ts';

interface CapturedClick {
	href: string;
	download: string | null;
}

declare global {
	interface Window {
		__sbgxClicks?: CapturedClick[];
	}
}

/**
 * Install a capture-phase click listener that records every `<a>` click on
 * the page and suppresses the real default action (navigation / download).
 *
 * Why an event listener instead of monkey-patching `prototype.click`:
 * Chrome extension content scripts run in an isolated JavaScript world with
 * their own copies of every prototype. When our content script (in its own
 * world) calls `a.click()`, it looks up `click` on the *isolated-world*
 * `HTMLAnchorElement.prototype`. A patch installed via `page.evaluate()`
 * runs in the *page world* and never gets hit. DOM events, by contrast,
 * are shared infrastructure - a capture-phase listener on `document` sees
 * clicks dispatched from either world, and `preventDefault` cancels the
 * anchor's default download regardless of where the click originated.
 *
 * This sidesteps all the real-download flakiness on this Chromium/Playwright
 * combo (page.route() bypasses, missing waitForRequest events, post-redirect
 * download.url() values, hung context teardown).
 */
async function installAnchorClickCapture(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.__sbgxClicks = [];
		document.addEventListener(
			'click',
			(e: Event) => {
				const target = e.target;
				if (target instanceof HTMLAnchorElement) {
					window.__sbgxClicks?.push({
						href: target.href,
						download: target.getAttribute('download'),
					});
					e.preventDefault();
					e.stopImmediatePropagation();
				}
			},
			true,
		);
	});
}

/** Read whatever {@link installAnchorClickCapture} captured. */
async function readCapturedAnchorClicks(page: Page): Promise<CapturedClick[]> {
	return page.evaluate(() => window.__sbgxClicks ?? []);
}

test.describe('Strava Bulk GPX extension', () => {
	test('mounts the toolbar above the activities table', async ({ extensionPage }) => {
		const toolbar = extensionPage.locator('.sbgx-toolbar');
		await expect(toolbar).toBeVisible();
		// Bulk button starts disabled (nothing selected).
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeDisabled();
		// "0 selected" appears after the bulk button (English locale forced
		// in the fixture; the localized string is from _locales/en/messages.json).
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('0 selected');
		// The bulk button itself uses a localized label.
		await expect(extensionPage.locator('[data-role="bulk"]')).toHaveText('Download selected');
	});

	test('injects checkbox + GPX button only for GPS-bearing rows', async ({ extensionPage }) => {
		// Three GPS-bearing rows (positive distance), two indoor (0 km).
		const gpsRows = extensionPage.locator('tr[data-sbgx-has-gps="1"]');
		const noGpsRows = extensionPage.locator('tr[data-sbgx-has-gps="0"]');
		await expect(gpsRows).toHaveCount(3);
		await expect(noGpsRows).toHaveCount(2);

		// GPS rows each have a checkbox + GPX button.
		await expect(extensionPage.locator('.sbgx-row-cb')).toHaveCount(3);
		await expect(extensionPage.locator('.sbgx-btn-row')).toHaveCount(3);

		// No-GPS rows have the placeholder cells but neither checkbox nor button.
		const indoorRow = noGpsRows.first();
		await expect(indoorRow.locator('.sbgx-row-cb')).toHaveCount(0);
		await expect(indoorRow.locator('.sbgx-btn-row')).toHaveCount(0);
	});

	test('"Select all visible" ticks only GPS rows and updates the count', async ({ extensionPage }) => {
		const selectAll = extensionPage.locator('.sbgx-select-all-cb');
		await selectAll.check();

		// All 3 GPS-row checkboxes become checked.
		const rowCbs = extensionPage.locator('.sbgx-row-cb');
		for (let i = 0; i < (await rowCbs.count()); i++) {
			await expect(rowCbs.nth(i)).toBeChecked();
		}
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('3 selected');
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeEnabled();

		// Untick - count returns to 0, button disables again.
		await selectAll.uncheck();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('0 selected');
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeDisabled();
	});

	test('toggling individual row checkboxes drives the count', async ({ extensionPage }) => {
		const cbs = extensionPage.locator('.sbgx-row-cb');
		await cbs.nth(0).check();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('1 selected');
		await cbs.nth(1).check();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('2 selected');
		await cbs.nth(0).uncheck();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('1 selected');
	});

	test('single-row GPX button targets export_gpx with the right id and filename', async ({ extensionPage }) => {
		// Rather than triggering a real download (which on this Chromium /
		// Playwright combo is flaky around page.route() interception, the
		// download event, and context teardown), monkey-patch
		// HTMLAnchorElement.prototype.click so the synthetic anchor that
		// downloader.ts creates is captured-but-not-actually-clicked. We
		// then inspect what our extension *asked the browser to do*: the
		// href and the `download` attribute - exactly the two things this
		// test cares about. No real network, no real download, no flakes.
		await installAnchorClickCapture(extensionPage);

		await extensionPage.locator('.sbgx-btn-row').first().click();

		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks).toHaveLength(1);
		const click = clicks[0]!;
		expect(click.href).toMatch(/\/activities\/9000000001\/export_gpx$/);
		expect(click.download).toBe('strava_9000000001.gpx');
	});

	test('format selector defaults to GPX with three options visible', async ({ extensionPage }) => {
		const select = extensionPage.locator('select[data-role="format"]');
		await expect(select).toHaveValue('gpx');
		// Three options: gpx, tcx, original.
		await expect(select.locator('option')).toHaveCount(3);
		await expect(select.locator('option[value="gpx"]')).toHaveText('GPX');
		await expect(select.locator('option[value="tcx"]')).toHaveText('TCX');
		await expect(select.locator('option[value="original"]')).toHaveText('Original');
	});

	test('changing format updates per-row button labels live', async ({ extensionPage }) => {
		const firstRowBtn = extensionPage.locator('.sbgx-btn-row').first();
		await expect(firstRowBtn).toHaveText('GPX');

		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await expect(firstRowBtn).toHaveText('TCX');
		await expect(firstRowBtn).toHaveAttribute('title', /TCX/);

		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await expect(firstRowBtn).toHaveText('Original');

		// And back to GPX for clean state.
		await extensionPage.locator('select[data-role="format"]').selectOption('gpx');
		await expect(firstRowBtn).toHaveText('GPX');
	});

	test('per-row button targets export_tcx when TCX format is selected', async ({ extensionPage }) => {
		// Same capture-not-click approach as the GPX test - we want to know
		// what URL/filename our extension asked for, not exercise Chromium's
		// download stack.
		await installAnchorClickCapture(extensionPage);

		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await extensionPage.locator('.sbgx-btn-row').first().click();

		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks).toHaveLength(1);
		const click = clicks[0]!;
		expect(click.href).toMatch(/\/activities\/9000000001\/export_tcx$/);
		expect(click.download).toBe('strava_9000000001.tcx');
	});

	test('per-row button targets export_original when Original format is selected', async ({ extensionPage }) => {
		// The "original" case deliberately omits the download attribute on
		// the anchor (downloader.ts: `if (filename) a.download = filename`,
		// where filename is null for original) so Chrome respects the
		// server's Content-Disposition header for the filename. We assert
		// both - the URL points at /export_original AND no `download`
		// attribute was set.
		await installAnchorClickCapture(extensionPage);

		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await extensionPage.locator('.sbgx-btn-row').first().click();

		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks).toHaveLength(1);
		const click = clicks[0]!;
		expect(click.href).toMatch(/\/activities\/9000000001\/export_original$/);
		expect(click.download).toBeNull();
	});

	test('merge button stays visible but disables with a tooltip outside GPX mode', async ({ extensionPage }) => {
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		// The default format is GPX, so the button starts visible, disabled
		// (nothing selected yet), and has NO `title` attribute. The content
		// script explicitly removes the attribute when merge is available,
		// rather than leaving an empty `title=""` hanging around.
		await expect(mergeBtn).toBeVisible();
		await expect(mergeBtn).toBeDisabled();
		await expect(mergeBtn).toHaveText('Merge selected into one GPX');
		await expect(mergeBtn).not.toHaveAttribute('title', /.+/);
		// Sanity: the previous-version `hidden` attribute (we used to hide
		// instead of disable) must NOT be present - if it is, dist/ is stale.
		await expect(mergeBtn).not.toHaveAttribute('hidden', /.*/);

		// Switching to TCX keeps it visible but disabled, with a tooltip
		// explaining the limitation - more discoverable than hiding silently.
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await expect(mergeBtn).toBeVisible();
		await expect(mergeBtn).toBeDisabled();
		await expect(mergeBtn).toHaveAttribute('title', 'Merging is only available in GPX mode');

		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await expect(mergeBtn).toBeDisabled();
		await expect(mergeBtn).toHaveAttribute('title', 'Merging is only available in GPX mode');

		// Back to GPX - tooltip is removed, button can become enabled once
		// rows are selected.
		await extensionPage.locator('select[data-role="format"]').selectOption('gpx');
		await expect(mergeBtn).not.toHaveAttribute('title', /.+/);
	});

	test('merge button stays disabled in non-GPX modes even when rows are selected', async ({ extensionPage }) => {
		// Regression guard: selecting rows must NOT bypass the GPX-only
		// constraint. Without this check, a user who selected rows in GPX
		// mode and then switched a format could click merge and trigger
		// a confusing failure.
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		await extensionPage.locator('.sbgx-select-all-cb').check();
		await expect(mergeBtn).toBeEnabled();

		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await expect(mergeBtn).toBeDisabled();

		await extensionPage.locator('select[data-role="format"]').selectOption('gpx');
		await expect(mergeBtn).toBeEnabled();
	});

	test('merge button enables when any GPS row is selected', async ({ extensionPage }) => {
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		await expect(mergeBtn).toBeDisabled();

		await extensionPage.locator('.sbgx-row-cb').first().check();
		await expect(mergeBtn).toBeEnabled();

		await extensionPage.locator('.sbgx-row-cb').first().uncheck();
		await expect(mergeBtn).toBeDisabled();
	});

	test('merging selected rows produces one combined GPX with all tracks', async ({ extensionPage }) => {
		// Stub /export_gpx for each of the three GPS-bearing fixture rows. Each
		// stub returns a minimal but valid GPX with one <trk> whose <name>
		// uniquely identifies which activity it came from - that's what we
		// assert against in the merged output.
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const url = route.request().url();
			const m = /\/activities\/(\d+)\/export_gpx/.exec(url);
			const id = m?.[1] ?? 'unknown';
			const body = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>activity-${id}</name>
    <trkseg>
      <trkpt lat="45.0" lon="13.0"><ele>10</ele></trkpt>
      <trkpt lat="45.1" lon="13.1"><ele>20</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;
			await route.fulfill({
				status: 200,
				contentType: 'application/gpx+xml',
				body,
			});
		});

		// Select all three GPS-bearing rows and click Merge.
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		await expect(mergeBtn).toBeEnabled();

		const downloadPromise = extensionPage.waitForEvent('download', { timeout: 10000 });
		await mergeBtn.click();
		const download = await downloadPromise;

		// Filename is strava_merged_<date>.gpx - date varies, so match by shape.
		expect(download.suggestedFilename()).toMatch(/^strava_merged_\d{4}-\d{2}-\d{2}\.gpx$/);

		// Pull the saved blob off disk and check it contains one <trk> per
		// activity, with the right <name> markers from our stub.
		const filePath = await download.path();
		expect(filePath).toBeTruthy();
		const { readFileSync } = await import('node:fs');
		const merged = readFileSync(filePath, 'utf8');
		expect(merged).toContain('<name>activity-9000000001</name>');
		expect(merged).toContain('<name>activity-9000000002</name>');
		expect(merged).toContain('<name>activity-9000000003</name>');
		// Exactly three <trk> blocks in the combined output.
		const trkOpens = merged.match(/<trk[\s>]/g) ?? [];
		expect(trkOpens.length).toBe(3);
		// The terminal status should celebrate the merge with the savedMerged
		// string rather than the regular savedActivities one.
		await expect(extensionPage.locator('[data-role="status-text"]')).toContainText(/merged GPX with 3/i);
	});
});
