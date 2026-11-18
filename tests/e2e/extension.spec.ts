// E2E behavior tests. Each test starts from a fresh fixture page with the
// content script already mounted (see tests/fixtures/extension.ts).

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { test, expect, type Page } from '../fixtures/extension.ts';
import { fakeRowsHtml, installFakePager, type FakeRow } from '../fixtures/pages.ts';

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

	test('header cells line up with the row cells', async ({ extensionPage }) => {
		// Strava's table sizes its columns from the header row, so the header
		// needs the same injected cells as each row, or every value sits one
		// column right of its heading.
		const lefts = (selector: string) =>
			extensionPage
				.locator(selector)
				.evaluateAll((cells) =>
					cells
						.filter((c) => getComputedStyle(c).display !== 'none')
						.map((c) => Math.round(c.getBoundingClientRect().left)),
				);
		const headerLefts = await lefts('thead tr > th');
		const rowLefts = await lefts('tr[data-sbgx-has-gps="1"] >> nth=0 >> > td');
		expect(headerLefts).toEqual(rowLefts);
		await expect(extensionPage.locator('thead th.sbgx-cell')).toHaveCount(2);
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

	test('remembers the selected format across page loads', async ({ extensionPage }) => {
		const select = extensionPage.locator('select[data-role="format"]');
		await select.selectOption('original');
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(select).toHaveValue('original');
		await expect(extensionPage.locator('.sbgx-btn-row').first()).toHaveText('Original');
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

	test('per-row button fetches export_original and keeps the uploaded file name', async ({ extensionPage }) => {
		// Original is fetched rather than linked: an activity without an
		// uploaded file redirects, and an anchor would navigate away to it.
		// With the default names, the file keeps the name Strava gives it.
		const requested: string[] = [];
		await extensionPage.route('**/activities/*/export_original', async (route) => {
			requested.push(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: 'application/octet-stream',
				headers: { 'Content-Disposition': 'attachment; filename="garmin-upload.fit"' },
				body: 'FIT',
			});
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		const { name } = await downloadFrom(extensionPage, () => extensionPage.locator('.sbgx-btn-row').first().click());
		expect(name).toBe('garmin-upload.fit');
		expect(requested).toEqual([expect.stringMatching(/\/activities\/9000000001\/export_original$/)]);
	});

	test('merge button adapts to the format and disables with a tooltip for Original', async ({ extensionPage }) => {
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		const format = extensionPage.locator('select[data-role="format"]');
		// The default format is GPX, so the button starts visible, disabled
		// (nothing selected yet), and has NO `title` attribute. The content
		// script explicitly removes the attribute in the default GPX mode,
		// rather than leaving an empty `title=""` hanging around.
		await expect(mergeBtn).toBeVisible();
		await expect(mergeBtn).toBeDisabled();
		await expect(mergeBtn).toHaveText('Merge selected into one GPX');
		await expect(mergeBtn).not.toHaveAttribute('title', /.+/);
		// Sanity: the previous-version `hidden` attribute (we used to hide
		// instead of disable) must NOT be present - if it is, dist/ is stale.
		await expect(mergeBtn).not.toHaveAttribute('hidden', /.*/);

		// TCX merges into one activity; label and tooltip say so.
		await format.selectOption('tcx');
		await expect(mergeBtn).toHaveText('Merge selected into one TCX');
		await expect(mergeBtn).toHaveAttribute(
			'title',
			'One activity with each selected activity as a lap, in time order.',
		);

		// Original can't be merged: still visible, disabled, with a tooltip
		// explaining why - more discoverable than hiding silently.
		await format.selectOption('original');
		await expect(mergeBtn).toBeVisible();
		await expect(mergeBtn).toBeDisabled();
		await expect(mergeBtn).toHaveAttribute('title', 'Merging works in GPX and TCX modes, not for Original files');

		// Back to GPX - tooltip is removed, button can become enabled once
		// rows are selected.
		await format.selectOption('gpx');
		await expect(mergeBtn).toHaveText('Merge selected into one GPX');
		await expect(mergeBtn).not.toHaveAttribute('title', /.+/);
	});

	test('merge button stays disabled for Original even when rows are selected', async ({ extensionPage }) => {
		// Regression guard: selecting rows must NOT bypass the Original-mode
		// constraint. Without this check, a user who selected rows in GPX
		// mode and then switched format could click merge and trigger a
		// confusing failure.
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		const format = extensionPage.locator('select[data-role="format"]');
		await extensionPage.locator('.sbgx-select-all-cb').check();
		await expect(mergeBtn).toBeEnabled();

		await format.selectOption('original');
		await expect(mergeBtn).toBeDisabled();

		await format.selectOption('tcx');
		await expect(mergeBtn).toBeEnabled();

		await format.selectOption('gpx');
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
		const merged = readFileSync(filePath, 'utf8');
		await expectWellFormed(extensionPage, merged);
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

// ---------- Helpers for the export-feature tests below ----------

/** Activity id from a stubbed /activities/<id>/export_* request. */
function idFromUrl(url: string): string {
	return /\/activities\/(\d+)\//.exec(url)?.[1] ?? 'unknown';
}

/** A minimal valid GPX whose track name identifies `id`, optionally with a start time and extra root children. */
function gpxBody(id: string, startTime?: string, extra = ''): string {
	const metadata = startTime ? `<metadata><time>${startTime}</time></metadata>` : '';
	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava" xmlns="http://www.topografix.com/GPX/1/1">${metadata}${extra}
  <trk><name>activity-${id}</name><trkseg><trkpt lat="45.0" lon="13.0"><ele>10</ele></trkpt></trkseg></trk>
</gpx>`;
}

/** Answer every /export_gpx request with {@link gpxBody}. */
async function stubGpxExports(page: Page): Promise<void> {
	await page.route('**/activities/*/export_gpx', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/gpx+xml',
			body: gpxBody(idFromUrl(route.request().url())),
		});
	});
}

/** Run `action` and return the file it makes the browser save. */
async function downloadFrom(page: Page, action: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
	const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
	await action();
	const download = await downloadPromise;
	return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

/**
 * Assert that `xml` is a well-formed XML document, as the browser parses it -
 * mapping tools and Strava's uploader reject anything else.
 */
async function expectWellFormed(page: Page, xml: string): Promise<void> {
	const error = await page.evaluate(
		(text) =>
			new DOMParser().parseFromString(text, 'application/xml').getElementsByTagName('parsererror')[0]?.textContent ??
			null,
		xml,
	);
	expect(error).toBeNull();
	expect(xml.match(/<\?xml /g)).toHaveLength(1);
}

/** Sorted file paths inside a zip (folder entries left out). */
async function zipFileNames(bytes: Buffer): Promise<string[]> {
	const zip = await JSZip.loadAsync(bytes);
	return Object.values(zip.files)
		.filter((f) => !f.dir)
		.map((f) => f.name)
		.sort();
}

/** CSV lines without the BOM, which is asserted separately. */
function csvLines(text: string): string[] {
	return text
		.replace(/^\uFEFF/, '')
		.trimEnd()
		.split('\r\n');
}

/**
 * Simulate Strava paginating: swap the table body for other activities, the
 * way its React re-render does, and wait for the extension to augment them.
 */
async function showOtherPage(page: Page, rows: FakeRow[]): Promise<void> {
	await page.evaluate((html) => {
		document.querySelector('tbody')!.innerHTML = html;
	}, fakeRowsHtml(rows));
	await page.locator(`tr[data-sbgx-id="${rows[0]!.id}"] .sbgx-row-cb`).waitFor();
}

test.describe('merge ordering', () => {
	test('merged tracks are chronological whatever order the responses arrive in', async ({ extensionPage }) => {
		// Rows are listed newest first (01, 02, 03); the delays make responses
		// land in a third order (01, 03, 02). Chronological is 03, 02, 01.
		const starts: Record<string, string> = {
			'9000000001': '2026-05-09T07:00:00Z',
			'9000000002': '2026-05-08T07:00:00Z',
			'9000000003': '2026-05-06T07:00:00Z',
		};
		const delays: Record<string, number> = { '9000000001': 0, '9000000002': 600, '9000000003': 300 };
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await new Promise((r) => setTimeout(r, delays[id] ?? 0));
			// 02 also carries a waypoint, which the GPX schema requires before
			// every <trk> in the merged document - not just before 02's own.
			const extra = id === '9000000002' ? '<wpt lat="45.05" lon="13.05"><name>summit</name></wpt>' : '';
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxBody(id, starts[id], extra) });
		});

		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="merge"]').click());
		const merged = bytes.toString('utf8');
		await expectWellFormed(extensionPage, merged);

		const positions = ['9000000003', '9000000002', '9000000001'].map((id) =>
			merged.indexOf(`<name>activity-${id}</name>`),
		);
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(merged.indexOf('<wpt')).toBeLessThan(merged.indexOf('<trk'));
	});
});

test.describe('zip entries', () => {
	test('Original uploads that share a filename all survive in the zip', async ({ extensionPage }) => {
		// JSZip silently replaces same-named entries, so without de-duplication
		// four of these five files (the indoor rows included - Original
		// exports them) would vanish from the archive.
		await extensionPage.route('**/activities/*/export_original', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/octet-stream',
				headers: { 'Content-Disposition': 'attachment; filename="activity.fit"' },
				body: `FIT ${idFromUrl(route.request().url())}`,
			});
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual([
			'activities.csv',
			'activity-2.fit',
			'activity-3.fit',
			'activity-4.fit',
			'activity-5.fit',
			'activity.fit',
		]);
	});
});

test.describe('selection across pages', () => {
	const otherPage: FakeRow[] = [
		{ id: '9000000006', sport: 'Ride', title: 'Gravel Loop' },
		{ id: '9000000007', sport: 'Hike', title: 'Ridge Hike' },
	];

	test('selections on other pages are counted and downloaded', async ({ extensionPage }) => {
		const cbs = extensionPage.locator('.sbgx-row-cb');
		const count = extensionPage.locator('[data-role="count"]');
		await cbs.nth(0).check();
		await cbs.nth(1).check();

		await showOtherPage(extensionPage, otherPage);
		await expect(count).toHaveText('2 selected (2 not on this page)');
		// Nothing on this page is ticked, but the earlier picks still count.
		await expect(extensionPage.locator('.sbgx-select-all-cb')).not.toBeChecked();
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeEnabled();

		await extensionPage.locator('tr[data-sbgx-id="9000000006"] .sbgx-row-cb').check();
		await expect(count).toHaveText('3 selected (2 not on this page)');

		await stubGpxExports(extensionPage);
		const { name, bytes } = await downloadFrom(extensionPage, () =>
			extensionPage.locator('[data-role="bulk"]').click(),
		);
		expect(name).toMatch(/^strava_gpx_\d{4}-\d{2}-\d{2}\.zip$/);
		expect(await zipFileNames(bytes)).toEqual([
			'activities.csv',
			'strava_9000000001.gpx',
			'strava_9000000002.gpx',
			'strava_9000000006.gpx',
		]);
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Saved 3 activities.');
	});

	test('Clear selection drops everything, including other pages', async ({ extensionPage }) => {
		const clear = extensionPage.locator('[data-role="clear"]');
		await expect(clear).toBeHidden();
		await extensionPage.locator('.sbgx-row-cb').first().check();
		await showOtherPage(extensionPage, otherPage);
		await extensionPage.locator('tr[data-sbgx-id="9000000007"] .sbgx-row-cb').check();

		await clear.click();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('0 selected');
		await expect(extensionPage.locator('tr[data-sbgx-id="9000000007"] .sbgx-row-cb')).not.toBeChecked();
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeDisabled();
		await expect(clear).toBeHidden();
	});

	test('shift-click selects and deselects a range of rows', async ({ extensionPage }) => {
		const cbs = extensionPage.locator('.sbgx-row-cb');
		const count = extensionPage.locator('[data-role="count"]');
		await cbs.nth(0).click();
		await cbs.nth(2).click({ modifiers: ['Shift'] });
		for (let i = 0; i < 3; i++) await expect(cbs.nth(i)).toBeChecked();
		await expect(count).toHaveText('3 selected');

		// The third row is now the anchor; shift-unticking the second clears 2-3.
		await cbs.nth(1).click({ modifiers: ['Shift'] });
		await expect(cbs.nth(0)).toBeChecked();
		await expect(cbs.nth(1)).not.toBeChecked();
		await expect(cbs.nth(2)).not.toBeChecked();
		await expect(count).toHaveText('1 selected');
	});
});

test.describe('file names', () => {
	test('"ID + title" names zip entries and per-row downloads, and is remembered', async ({ extensionPage }) => {
		const names = extensionPage.locator('select[data-role="names"]');
		await expect(names).toHaveValue('id');
		await names.selectOption('title');
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(names).toHaveValue('title');

		await stubGpxExports(extensionPage);
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual([
			'9000000001_Traversa v19 feat. Ex Acini Novi Šćapi.gpx',
			'9000000002_Lunch Trail Run.gpx',
			'9000000003_Morning Run.gpx',
			'activities.csv',
		]);

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbgx-btn-row').first().click();
		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks.map((c) => c.download)).toEqual(['9000000001_Traversa v19 feat. Ex Acini Novi Šćapi.gpx']);
	});

	test('"Sport folders" groups zip entries by sport', async ({ extensionPage }) => {
		await extensionPage.locator('select[data-role="names"]').selectOption('sport');
		await stubGpxExports(extensionPage);
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual([
			'Run/9000000003_Morning Run.gpx',
			'Trail Run/9000000001_Traversa v19 feat. Ex Acini Novi Šćapi.gpx',
			'Trail Run/9000000002_Lunch Trail Run.gpx',
			'activities.csv',
		]);
	});

	test('Original with a custom name keeps the uploaded extension', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*/export_original', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/octet-stream',
				headers: { 'Content-Disposition': 'attachment; filename="garmin-upload.fit"' },
				body: 'FIT',
			});
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await extensionPage.locator('select[data-role="names"]').selectOption('title');
		const { name } = await downloadFrom(extensionPage, () => extensionPage.locator('.sbgx-btn-row').first().click());
		expect(name).toBe('9000000001_Traversa v19 feat. Ex Acini Novi Šćapi.fit');
	});
});

test.describe('CSV', () => {
	test('bulk zips carry an activities.csv of the table columns', async ({ extensionPage }) => {
		await stubGpxExports(extensionPage);
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		const zip = await JSZip.loadAsync(bytes);
		const csv = (await zip.file('activities.csv')!.async('nodebuffer')).toString('utf8');

		expect(csv.startsWith('\uFEFF')).toBe(true);
		const lines = csvLines(csv);
		expect(lines[0]).toBe(
			'Activity ID,URL,File,Date (YYYY-MM-DD),Sport,Date,Title,Time,Distance,Elevation,Relative Effort',
		);
		// "Sat, 09/05/2026" alone could be 9 May or 5 September (both
		// Saturdays); "Fri, 08/05/2026" further down settles it as day-first.
		expect(lines).toContain(
			'9000000001,https://www.strava.com/activities/9000000001,strava_9000000001.gpx,2026-05-09,Trail Run,' +
				'"Sat, 09/05/2026",Traversa v19 feat. Ex Acini Novi Šćapi,5:32:41,48.11 km,"1,889 m",109',
		);
		expect(lines).toHaveLength(4);
	});

	test('Export list saves the selection as CSV without fetching any activity file', async ({ extensionPage }) => {
		const exportRequests: string[] = [];
		extensionPage.on('request', (req) => {
			if (req.url().includes('/export_')) exportRequests.push(req.url());
		});
		await extensionPage.locator('.sbgx-row-cb').nth(1).check();
		// A title a spreadsheet would evaluate as a formula, on another page.
		await showOtherPage(extensionPage, [{ id: '9000000008', sport: 'Ride', title: '=1+1' }]);
		await extensionPage.locator('tr[data-sbgx-id="9000000008"] .sbgx-row-cb').check();

		const { name, bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="csv"]').click());
		expect(name).toMatch(/^strava_activities_\d{4}-\d{2}-\d{2}\.csv$/);
		const lines = csvLines(bytes.toString('utf8'));
		expect(lines[0]).toBe('Activity ID,URL,Date (YYYY-MM-DD),Sport,Date,Title,Time,Distance,Elevation,Relative Effort');
		expect(lines[1]).toContain(',2026-05-08,Trail Run,"Fri, 08/05/2026",Lunch Trail Run,');
		expect(lines[2]).toContain(",'=1+1,");
		expect(exportRequests).toEqual([]);
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Saved a list of 2 activities.');
	});
});

test.describe('cancel, retry and rate limits', () => {
	test('Cancel stops a running bulk download and saves nothing', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			await new Promise((r) => setTimeout(r, 3000));
			// The extension aborts these requests, so fulfilling may throw.
			await route
				.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxBody('slow') })
				.catch(() => undefined);
		});
		let downloads = 0;
		extensionPage.on('download', () => downloads++);

		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		const cancel = extensionPage.locator('[data-role="cancel"]');
		await expect(cancel).toBeVisible();
		await cancel.click();

		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Cancelled - nothing was saved.');
		await expect(cancel).toBeHidden();
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeEnabled();
		await extensionPage.waitForTimeout(500);
		expect(downloads).toBe(0);
	});

	test('failures are listed, and Retry fetches only those', async ({ extensionPage }) => {
		let failSecond = true;
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			if (id === '9000000002' && failSecond) {
				failSecond = false;
				await route.fulfill({ status: 500, body: '' });
				return;
			}
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxBody(id) });
		});

		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual(['activities.csv', 'strava_9000000001.gpx', 'strava_9000000003.gpx']);
		const status = extensionPage.locator('[data-role="status-text"]');
		await expect(status).toHaveText('Saved 2, skipped 1 (HTTP 500)');

		const failures = extensionPage.locator('[data-role="failures"]');
		await failures.locator('summary').click();
		await expect(failures.locator('li')).toHaveText(['Lunch Trail Run - HTTP 500']);
		const retry = extensionPage.locator('[data-role="retry"]');
		await expect(retry).toHaveText('Retry 1 failed');

		// One activity left → a plain single-file download, which the capture records.
		await installAnchorClickCapture(extensionPage);
		await retry.click();
		await expect(status).toHaveText('Saved 1 activities.');
		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks.map((c) => c.href)).toEqual([expect.stringMatching(/\/activities\/9000000002\/export_gpx$/)]);
		await expect(failures).toBeHidden();
	});

	test('a rate-limited request waits for Retry-After, then succeeds', async ({ extensionPage }) => {
		const hits: Record<string, number> = {};
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			hits[id] = (hits[id] ?? 0) + 1;
			if (id === '9000000001' && hits[id] === 1) {
				await route.fulfill({ status: 429, headers: { 'Retry-After': '2' }, body: '' });
				return;
			}
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxBody(id) });
		});

		await extensionPage.locator('.sbgx-select-all-cb').check();
		const status = extensionPage.locator('[data-role="status-text"]');
		const started = Date.now();
		const { bytes } = await downloadFrom(extensionPage, async () => {
			await extensionPage.locator('[data-role="bulk"]').click();
			await expect(status).toContainText('Strava is limiting requests - retrying in');
		});

		expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
		expect(hits['9000000001']).toBe(2);
		expect(await zipFileNames(bytes)).toEqual([
			'activities.csv',
			'strava_9000000001.gpx',
			'strava_9000000002.gpx',
			'strava_9000000003.gpx',
		]);
		await expect(status).toHaveText('Saved 3 activities.');
	});
});

const activityFixture = readFileSync(new URL('../fixtures/strava-activity.html', import.meta.url), 'utf8');

/**
 * Open the activity-page fixture at /activities/9000000001. With
 * `own: false` its Export Original item is removed, which is how Strava's
 * menu looks on activities you can't export.
 */
async function openActivityPage(page: Page, { own = true } = {}): Promise<void> {
	const html = own
		? activityFixture
		: activityFixture.replace(/\s*<li><a href="[^"]*\/export_original">[^<]*<\/a><\/li>/, '');
	await page.route('https://www.strava.com/activities/*', async (route) => {
		await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
	});
	await page.goto('https://www.strava.com/activities/9000000001');
}

test.describe('activity page', () => {
	test('adds Export TCX right after Export GPX on your own activity', async ({ extensionPage }) => {
		await openActivityPage(extensionPage);
		const tcx = extensionPage.locator('a[href$="/export_tcx"]');
		await tcx.waitFor({ state: 'attached' });
		await expect(tcx).toHaveAttribute('href', '/activities/9000000001/export_tcx');
		const items = await extensionPage.locator('ul.options > li').allTextContents();
		expect(items.slice(4, 7)).toEqual(['Export GPX', 'Export TCX', 'Export Original']);
	});

	test('leaves the menu alone on activities without Export Original', async ({ extensionPage }) => {
		await openActivityPage(extensionPage, { own: false });
		await extensionPage.locator('a[href$="/export_gpx"]').waitFor({ state: 'attached' });
		// The script runs at document_idle; give it time to (not) act.
		await extensionPage.waitForTimeout(500);
		await expect(extensionPage.locator('a[href$="/export_tcx"]')).toHaveCount(0);
	});
});

test.describe('⋯ menu', () => {
	test("opens above Strava's row controls and keeps its file input hidden", async ({ extensionPage }) => {
		// Wide enough for the toolbar to fit on one line, which puts the menu
		// over the rows' Share controls.
		await extensionPage.setViewportSize({ width: 1600, height: 800 });
		await extensionPage.locator('[data-role="more"] > summary').click();
		const menu = extensionPage.locator('.sbgx-menu');
		await expect(menu).toBeVisible();
		// The fixture displays file inputs and stacks Share drop-downs at
		// z-index 30, like Strava's stylesheets do.
		await expect(extensionPage.locator('[data-role="history-file"]')).toBeHidden();
		const covered = await menu.evaluate((m) => {
			const box = m.getBoundingClientRect();
			const shares = [...document.querySelectorAll('.share')]
				.map((s) => s.getBoundingClientRect())
				.filter((s) => s.right > box.left && s.left < box.right && s.bottom > box.top && s.top < box.bottom);
			// Every point where a Share control lies under the menu must hit the menu.
			return {
				overlapping: shares.length,
				onTop: shares.every((s) => {
					const x = (Math.max(s.left, box.left) + Math.min(s.right, box.right)) / 2;
					const y = (Math.max(s.top, box.top) + Math.min(s.bottom, box.bottom)) / 2;
					const hit = document.elementFromPoint(x, y);
					return hit !== null && m.contains(hit);
				}),
			};
		});
		expect(covered.overlapping).toBeGreaterThan(0);
		expect(covered.onTop).toBe(true);
	});

	test('opens rightwards when the toolbar wraps it to the left edge', async ({ extensionPage }) => {
		await extensionPage.setViewportSize({ width: 1000, height: 800 });
		await extensionPage.locator('[data-role="more"] > summary').click();
		const box = (await extensionPage.locator('.sbgx-menu').boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(1000);
	});
});

test.describe('export history', () => {
	test('zip downloads mark activities as exported, and Select new skips them', async ({ extensionPage }) => {
		await stubGpxExports(extensionPage);
		const cbs = extensionPage.locator('.sbgx-row-cb');
		const done = extensionPage.locator('.sbgx-done');
		await cbs.nth(0).check();
		await cbs.nth(1).check();
		await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());

		await expect(done.nth(0)).toBeVisible();
		await expect(done.nth(1)).toBeVisible();
		await expect(done.nth(2)).toBeHidden();
		await expect(done.nth(0)).toHaveAttribute('title', /^Exported as GPX on /);

		await extensionPage.locator('[data-role="clear"]').click();
		await extensionPage.locator('[data-role="select-new"]').click();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('1 selected');
		await expect(cbs.nth(2)).toBeChecked();

		// History is per format - nothing has been exported as TCX yet.
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await expect(done.nth(0)).toBeHidden();
		await extensionPage.locator('[data-role="select-new"]').click();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('3 selected');
	});

	test('per-row downloads are remembered across reloads, and Forget clears them', async ({ extensionPage }) => {
		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbgx-btn-row').first().click();
		const done = extensionPage.locator('.sbgx-done').first();
		await expect(done).toBeVisible();

		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(done).toBeVisible();

		await extensionPage.locator('[data-role="more"] > summary').click();
		const forget = extensionPage.locator('[data-role="history-forget"]');
		await forget.click();
		await expect(forget).toHaveText('Click again to confirm');
		await expect(done).toBeVisible();
		await forget.click();
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Export history cleared.');
		await expect(done).toBeHidden();
		await expect(forget).toBeDisabled();
	});

	test('history can be seeded from an earlier activities.csv', async ({ extensionPage }) => {
		await extensionPage.locator('[data-role="more"] > summary').click();
		await expect(extensionPage.locator('[data-role="history-import"]')).toHaveText(
			'Mark activities from a CSV as exported (GPX)…',
		);
		await extensionPage.locator('[data-role="history-file"]').setInputFiles({
			name: 'activities.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(
				'\uFEFFActivity ID,URL,Title\r\n' +
					'9000000001,https://www.strava.com/activities/9000000001,"Long, ""hilly"" day"\r\n' +
					'9000000003,https://www.strava.com/activities/9000000003,Morning Run\r\n',
			),
		});
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText(
			'Marked 2 activities as exported (GPX).',
		);
		const done = extensionPage.locator('.sbgx-done');
		await expect(done.nth(0)).toBeVisible();
		await expect(done.nth(1)).toBeHidden();
		await expect(done.nth(2)).toBeVisible();
	});
});

/** A GPX with two timed track points `minutes` apart, starting at `start`, typed as a run. */
function timedGpx(id: string, start: string, minutes: number): string {
	const t0 = Date.parse(start);
	const point = (offset: number) =>
		`<trkpt lat="45.0" lon="13.0"><time>${new Date(t0 + offset * 60_000).toISOString()}</time></trkpt>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava" xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>${start}</time></metadata>
  <trk><name>activity-${id}</name><type>running</type><trkseg>${point(0)}${point(minutes)}</trkseg></trk>
</gpx>`;
}

/** A one-lap TCX activity with a trackpoint per cumulative distance, a minute apart. */
function tcxBody(sport: string, start: string, distances: number[]): string {
	const t0 = Date.parse(start);
	const points = distances
		.map(
			(d, i) =>
				`<Trackpoint><Time>${new Date(t0 + i * 60_000).toISOString()}</Time><DistanceMeters>${d}</DistanceMeters></Trackpoint>`,
		)
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="${sport}"><Id>${start}</Id><Lap StartTime="${start}"><TotalTimeSeconds>${(distances.length - 1) * 60}</TotalTimeSeconds><DistanceMeters>${distances.at(-1)}</DistanceMeters><Track>${points}</Track></Lap><Notes>${sport} notes</Notes></Activity></Activities></TrainingCenterDatabase>`;
}

/** Switch the "⋯" menu's GPX merge setting. */
async function setMergeMode(page: Page, mode: 'tracks' | 'single'): Promise<void> {
	await page.locator('[data-role="more"] > summary').click();
	await page.locator('select[data-role="merge-mode"]').selectOption(mode);
	await page.locator('[data-role="more"] > summary').click();
}

test.describe('merge modes', () => {
	test('"One activity" joins the tracks into one, a segment per activity in time order', async ({ extensionPage }) => {
		const starts: Record<string, string> = {
			'9000000001': '2026-05-09T07:00:00.000Z',
			'9000000002': '2026-05-08T07:00:00.000Z',
			'9000000003': '2026-05-06T07:00:00.000Z',
		};
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: timedGpx(id, starts[id]!, 60) });
		});
		await setMergeMode(extensionPage, 'single');
		const mergeBtn = extensionPage.locator('[data-role="merge"]');
		await expect(mergeBtn).toHaveText('Join selected into one activity');
		await expect(mergeBtn).toHaveAttribute('title', /for uploading to Strava as a single activity/);

		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { name, bytes } = await downloadFrom(extensionPage, () => mergeBtn.click());
		expect(name).toMatch(/^strava_joined_\d{4}-\d{2}-\d{2}\.gpx$/);
		const joined = bytes.toString('utf8');
		await expectWellFormed(extensionPage, joined);
		expect(joined.match(/<trk[\s>]/g)).toHaveLength(1);
		expect(joined.match(/<trkseg[\s>]/g)).toHaveLength(3);
		// Named and typed after the earliest activity; <type> precedes the segments.
		expect(joined).toContain('<trk><name>activity-9000000003</name><type>running</type><trkseg>');
		const order = ['2026-05-06', '2026-05-08', '2026-05-09'].map((day) => joined.indexOf(`<time>${day}T07:00`));
		expect(order.every((i) => i > 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText(
			'Saved one activity joined from 3 activities.',
		);
	});

	test('joining refuses activities that overlap in time', async ({ extensionPage }) => {
		// 02 runs 07:00-08:00; 01 starts at 07:30 the same day.
		const starts: Record<string, string> = {
			'9000000001': '2026-05-08T07:30:00.000Z',
			'9000000002': '2026-05-08T07:00:00.000Z',
		};
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: timedGpx(id, starts[id]!, 60) });
		});
		let downloads = 0;
		extensionPage.on('download', () => downloads++);
		await setMergeMode(extensionPage, 'single');
		await extensionPage.locator('.sbgx-row-cb').nth(0).check();
		await extensionPage.locator('.sbgx-row-cb').nth(1).check();
		await extensionPage.locator('[data-role="merge"]').click();
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText(
			"Failed: Can't join activities that overlap in time: Lunch Trail Run and Traversa v19 feat. Ex Acini Novi Šćapi",
		);
		expect(downloads).toBe(0);
	});

	test('TCX merge makes one activity of every lap, with distances carrying on', async ({ extensionPage }) => {
		const sources: Record<string, [string, string, number[]]> = {
			'9000000001': ['Running', '2026-05-09T07:00:00.000Z', [0, 1000, 2000]],
			'9000000002': ['Running', '2026-05-08T07:00:00.000Z', [0, 500]],
			'9000000003': ['Biking', '2026-05-06T07:00:00.000Z', [0, 300]],
		};
		await extensionPage.route('**/activities/*/export_tcx', async (route) => {
			const [sport, start, distances] = sources[idFromUrl(route.request().url())]!;
			await route.fulfill({ status: 200, contentType: 'application/xml', body: tcxBody(sport, start, distances) });
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { name, bytes } = await downloadFrom(extensionPage, () =>
			extensionPage.locator('[data-role="merge"]').click(),
		);
		expect(name).toMatch(/^strava_merged_\d{4}-\d{2}-\d{2}\.tcx$/);
		const merged = bytes.toString('utf8');
		await expectWellFormed(extensionPage, merged);

		expect(merged.match(/<Activity[\s>]/g)).toHaveLength(1);
		expect(merged).toContain('<Activity Sport="Other">');
		const lapStarts = [...merged.matchAll(/<Lap StartTime="([^"]+)"/g)].map((m) => m[1]);
		expect(lapStarts).toEqual(['2026-05-06T07:00:00.000Z', '2026-05-08T07:00:00.000Z', '2026-05-09T07:00:00.000Z']);
		// Trackpoint distances continue across activities (Biking 300 m, then
		// Running 500 m, then Running 2000 m); lap totals stay per lap.
		const pointDistances = [...merged.matchAll(/<Trackpoint>.*?<DistanceMeters>([^<]+)<\/DistanceMeters>/g)].map((m) =>
			Number(m[1]),
		);
		expect(pointDistances).toEqual([0, 300, 300, 800, 800, 1800, 2800]);
		const lapTotals = [...merged.matchAll(/<\/TotalTimeSeconds><DistanceMeters>([^<]+)</g)].map((m) => Number(m[1]));
		expect(lapTotals).toEqual([300, 500, 2000]);
		// Laps sit before the base activity's <Notes>, as the schema requires.
		expect(merged.indexOf('<Notes>')).toBeGreaterThan(merged.lastIndexOf('</Lap>'));
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Saved merged TCX with 3 activities.');
	});
});

/**
 * A GPX running east along 45°N, one point per longitude offset (degrees
 * east of 13°). At that latitude 0.001° of longitude is ~79 m.
 */
function lineGpx(id: string, offsets: number[]): string {
	const points = offsets.map((o) => `<trkpt lat="45" lon="${(13 + o).toFixed(4)}"></trkpt>`).join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava" xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>2026-05-09T07:00:00Z</time></metadata><trk><name>activity-${id}</name><trkseg>${points}</trkseg></trk></gpx>`;
}

// Out 4 points, back past the start, then away to the end. With 200 m,
// offsets ≤ 0.0025 from either end are hidden - including the mid-route
// pass near the start, which cuts the track in two.
const OUT_AND_BACK = [
	0, 0.001, 0.002, 0.003, 0.004, 0.003, 0.002, 0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01,
];

/** Pick a Hide start/end radius ('0' = off) in the "⋯" menu. */
async function setTrim(page: Page, radius: '0' | '200' | '500' | '1000'): Promise<void> {
	await page.locator('[data-role="more"] > summary').click();
	await page.locator('select[data-role="trim"]').selectOption(radius);
	await page.locator('[data-role="more"] > summary').click();
}

test.describe('hide start/end', () => {
	test('trims near the start and end, splits where the track passes near them, and marks the file', async ({
		extensionPage,
	}) => {
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: lineGpx(id, OUT_AND_BACK) });
		});
		await setTrim(extensionPage, '200');
		const chip = extensionPage.locator('[data-role="trim-chip"]');
		await expect(chip).toHaveText(/Hiding 200 m at start and end/);

		const { name, bytes } = await downloadFrom(extensionPage, () =>
			extensionPage.locator('.sbgx-btn-row').first().click(),
		);
		expect(name).toBe('strava_9000000001_trimmed.gpx');
		const gpx = bytes.toString('utf8');
		await expectWellFormed(extensionPage, gpx);
		const kept = [...gpx.matchAll(/lon="([^"]+)"/g)].map((m) => (Number(m[1]) - 13).toFixed(3));
		expect(kept).toEqual(['0.003', '0.004', '0.003', '0.003', '0.004', '0.005', '0.006', '0.007']);
		expect(gpx.match(/<trkseg[\s>]/g)).toHaveLength(2);
		expect(gpx).toContain(
			"<metadata><desc>Start and end hidden (200 m) by Strava Bulk GPX Export - not Strava's original export.</desc><time>",
		);
		// A trimmed file isn't a backup: no ✓.
		await extensionPage.waitForTimeout(300);
		await expect(extensionPage.locator('.sbgx-done').first()).toBeHidden();

		// Not remembered: a reload turns it off.
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(chip).toBeHidden();
		await expect(extensionPage.locator('select[data-role="trim"]')).toHaveValue('0');
	});

	test('trimmed zips are marked and skip history; a fully hidden track fails; not for Original', async ({
		extensionPage,
	}) => {
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: lineGpx(id, OUT_AND_BACK) });
		});
		await setTrim(extensionPage, '200');
		await extensionPage.locator('.sbgx-row-cb').nth(0).check();
		await extensionPage.locator('.sbgx-row-cb').nth(1).check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual([
			'activities.csv',
			'strava_9000000001_trimmed.gpx',
			'strava_9000000002_trimmed.gpx',
		]);
		const status = extensionPage.locator('[data-role="status-text"]');
		await expect(status).toHaveText('Saved 2 activities.');
		await expect(extensionPage.locator('.sbgx-done').first()).toBeHidden();

		// 1 km covers this whole ~790 m track.
		await setTrim(extensionPage, '1000');
		await extensionPage.locator('[data-role="bulk"]').click();
		await expect(status).toHaveText(
			'Failed: All 2 downloads failed. First error: the whole track is within the hidden distance',
		);

		// TCX is trimmed too; Original files aren't: the chip goes and the
		// setting disables.
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await expect(extensionPage.locator('[data-role="trim-chip"]')).toBeVisible();
		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await expect(extensionPage.locator('[data-role="trim-chip"]')).toBeHidden();
		await expect(extensionPage.locator('select[data-role="trim"]')).toBeDisabled();
		await expect(extensionPage.locator('select[data-role="trim"]')).toHaveAttribute(
			'title',
			'Not available for Original files',
		);
	});
});

test.describe('selecting across pages', () => {
	const middle: FakeRow[] = [
		{ id: '9000000006', sport: 'Ride', title: 'Gravel Loop' },
		{ id: '9000000007', sport: 'Hike', title: 'Ridge Hike' },
	];
	const last: FakeRow[] = [
		{ id: '9000000008', sport: 'Run', title: 'Track Session' },
		{ id: '9000000009', sport: 'Workout', title: 'Core', distance: '0 km' },
	];

	test('"Select all pages" goes back to the first page, then on to the last', async ({ extensionPage }) => {
		// Start on the middle page, so the walk has to go both ways.
		await installFakePager(extensionPage, ['', fakeRowsHtml(middle), fakeRowsHtml(last)], 1);
		await extensionPage.locator('tr[data-sbgx-id="9000000006"] .sbgx-row-cb').waitFor();
		await extensionPage.locator('[data-role="select-pages"]').click();

		const status = extensionPage.locator('[data-role="status-text"]');
		// The fixture's 3 GPS rows, both middle rows, and the last page's
		// GPS row - not its indoor one (GPX mode).
		await expect(status).toHaveText('Added 6 activities from 3 pages.');
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('6 selected (5 not on this page)');
		await expect(extensionPage.locator('.pagination .pages')).toHaveText('41-60 of 60');
		await expect(extensionPage.locator('tr[data-sbgx-id="9000000008"] .sbgx-row-cb')).toBeChecked();

		await stubGpxExports(extensionPage);
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toHaveLength(7);
	});

	test('"Select new on all pages" skips exported activities, and Cancel keeps what was picked', async ({
		extensionPage,
	}) => {
		await extensionPage.locator('[data-role="more"] > summary').click();
		await extensionPage.locator('[data-role="history-file"]').setInputFiles({
			name: 'activities.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('Activity ID\r\n9000000001\r\n9000000006\r\n'),
		});
		await installFakePager(extensionPage, ['', fakeRowsHtml(middle), fakeRowsHtml(last)], 0);
		await extensionPage.locator('[data-role="select-new-pages"]').click();
		const status = extensionPage.locator('[data-role="status-text"]');
		await expect(status).toHaveText('Added 4 activities from 3 pages.');

		// A slow page: cancel while waiting for it.
		await extensionPage.locator('[data-role="clear"]').click();
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await installFakePager(extensionPage, ['', fakeRowsHtml(middle)], 0, { delayMs: 3000 });
		await extensionPage.locator('[data-role="select-pages"]').click();
		await expect(status).toContainText('Selecting on every page… 1-20 of 40 (3 selected)');
		await extensionPage.locator('[data-role="cancel"]').click();
		await expect(status).toHaveText('Stopped - added 3 activities so far.');
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText(/^3 selected/);
	});

	test('the selection survives a reload, until it is cleared', async ({ extensionPage }) => {
		const count = extensionPage.locator('[data-role="count"]');
		await extensionPage.locator('.sbgx-row-cb').nth(0).check();
		await showOtherPage(extensionPage, middle);
		await extensionPage.locator('tr[data-sbgx-id="9000000007"] .sbgx-row-cb').check();
		// Saving is batched; give it a moment.
		await extensionPage.waitForTimeout(600);

		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(count).toHaveText('2 selected (1 not on this page)');
		await expect(extensionPage.locator('.sbgx-row-cb').nth(0)).toBeChecked();

		await extensionPage.locator('[data-role="clear"]').click();
		await extensionPage.waitForTimeout(600);
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(count).toHaveText('0 selected');
	});
});

test.describe('activities without GPS', () => {
	test('can be exported as Original, and are deselected when switching to GPX', async ({ extensionPage }) => {
		const format = extensionPage.locator('select[data-role="format"]');
		await expect(extensionPage.locator('.sbgx-row-cb')).toHaveCount(3);
		await format.selectOption('original');
		await expect(extensionPage.locator('.sbgx-row-cb')).toHaveCount(5);
		await expect(extensionPage.locator('tr[data-sbgx-has-gps="0"] .sbgx-btn-row').first()).toHaveText('Original');

		// A strength session with a FIT file, and a manual entry without one:
		// Strava answers that with an HTML page.
		await extensionPage.route('**/activities/*/export_original', async (route) => {
			const id = idFromUrl(route.request().url());
			if (id === '9000000005') {
				await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html></html>' });
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/octet-stream',
				headers: { 'Content-Disposition': `attachment; filename="${id}.fit"` },
				body: 'FIT',
			});
		});
		await extensionPage.locator('tr[data-sbgx-has-gps="0"] .sbgx-row-cb').nth(0).check();
		await extensionPage.locator('tr[data-sbgx-has-gps="0"] .sbgx-row-cb').nth(1).check();
		await extensionPage.locator('.sbgx-row-cb').nth(0).check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual(['9000000001.fit', '9000000004.fit', 'activities.csv']);
		const status = extensionPage.locator('[data-role="status-text"]');
		await expect(status).toHaveText('Saved 2, skipped 1 (Strava has no Original file for this activity)');

		await format.selectOption('gpx');
		await expect(status).toHaveText('Deselected 2 activities without GPS - they have no GPX export, only Original.');
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('1 selected');
		await expect(extensionPage.locator('.sbgx-row-cb')).toHaveCount(3);
	});

	test('an export that comes back as a web page is a failure, not a saved file', async ({ extensionPage }) => {
		// Strava redirects an export it doesn't have to an HTML page. (Not
		// simulated with a real redirect: Playwright doesn't route the
		// request that follows one, so it would reach strava.com.)
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			if (id === '9000000003') {
				await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html></html>' });
				return;
			}
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxBody(id) });
		});
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual(['activities.csv', 'strava_9000000001.gpx', 'strava_9000000002.gpx']);
		const failures = extensionPage.locator('[data-role="failures"]');
		await failures.locator('summary').click();
		await expect(failures.locator('li')).toHaveText(['Morning Run - Strava has no GPX file for this activity']);
	});
});

test.describe('date names and split zips', () => {
	test('"Date + title" names files by date, and falls back to the ID without one', async ({ extensionPage }) => {
		await extensionPage.locator('select[data-role="names"]').selectOption('date');
		// A date the extension can't read.
		await extensionPage
			.locator('tr[data-sbgx-id="9000000003"] td')
			.nth(2)
			.evaluate((td) => (td.textContent = 'Yesterday'));
		await stubGpxExports(extensionPage);
		await extensionPage.locator('.sbgx-select-all-cb').check();
		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual([
			'2026-05-08_Lunch Trail Run.gpx',
			'2026-05-09_Traversa v19 feat. Ex Acini Novi Šćapi.gpx',
			'9000000003_Morning Run.gpx',
			'activities.csv',
		]);
	});

	test('large downloads are split into zips saved as they fill, each with its own CSV', async ({ extensionPage }) => {
		await stubGpxExports(extensionPage);
		await extensionPage.locator('[data-role="more"] > summary').click();
		const split = extensionPage.locator('select[data-role="split"]');
		await expect(split).toHaveValue('500');
		// Each stubbed GPX is ~280 bytes; a 600-byte limit fits two per zip.
		await split.evaluate((select: HTMLSelectElement) => {
			select.add(new Option('600 bytes', '0.0006'));
			select.value = '0.0006';
			select.dispatchEvent(new Event('change'));
		});
		await extensionPage.locator('[data-role="more"] > summary').click();

		const downloads: { name: string; bytes: Buffer }[] = [];
		extensionPage.on('download', async (download) => {
			downloads.push({ name: download.suggestedFilename(), bytes: readFileSync(await download.path()) });
		});
		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Saved 3 activities in 2 zips.');
		await expect.poll(() => downloads.length).toBe(2);

		downloads.sort((a, b) => a.name.localeCompare(b.name));
		expect(downloads.map((d) => d.name)).toEqual([
			expect.stringMatching(/^strava_gpx_\d{4}-\d{2}-\d{2}_part1\.zip$/),
			expect.stringMatching(/^strava_gpx_\d{4}-\d{2}-\d{2}_part2\.zip$/),
		]);
		const [first, second] = await Promise.all(downloads.map((d) => zipFileNames(d.bytes)));
		expect(first).toHaveLength(3);
		expect(second).toHaveLength(2);
		expect(first).toContain('activities.csv');
		expect(second).toContain('activities.csv');
		// Every part counts as exported.
		await expect(extensionPage.locator('.sbgx-done:visible')).toHaveCount(3);
	});
});

/**
 * A TCX running east along 45°N with heart rate on every trackpoint, one
 * point per longitude offset (see {@link lineGpx}).
 */
function lineTcx(offsets: number[]): string {
	const points = offsets
		.map(
			(o, i) =>
				`<Trackpoint><Time>2026-05-09T07:${String(i).padStart(2, '0')}:00Z</Time>` +
				`<Position><LatitudeDegrees>45</LatitudeDegrees><LongitudeDegrees>${(13 + o).toFixed(4)}</LongitudeDegrees></Position>` +
				`<HeartRateBpm><Value>${120 + i}</Value></HeartRateBpm></Trackpoint>`,
		)
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Id>2026-05-09T07:00:00Z</Id><Lap StartTime="2026-05-09T07:00:00Z"><Track>${points}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

test.describe('hide start/end in TCX', () => {
	test('hides positions near the start and end but keeps the heart rate, splitting the track', async ({
		extensionPage,
	}) => {
		await extensionPage.route('**/activities/*/export_tcx', async (route) => {
			await route.fulfill({ status: 200, contentType: 'application/xml', body: lineTcx(OUT_AND_BACK) });
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await setTrim(extensionPage, '200');
		const { name, bytes } = await downloadFrom(extensionPage, () =>
			extensionPage.locator('.sbgx-btn-row').first().click(),
		);
		expect(name).toBe('strava_9000000001_trimmed.tcx');
		const tcx = bytes.toString('utf8');
		await expectWellFormed(extensionPage, tcx);
		// Every trackpoint and its heart rate stays; only the positions near
		// the ends go - the same points the GPX test keeps.
		expect(tcx.match(/<Trackpoint>/g)).toHaveLength(OUT_AND_BACK.length);
		expect(tcx.match(/<HeartRateBpm>/g)).toHaveLength(OUT_AND_BACK.length);
		const kept = [...tcx.matchAll(/<LongitudeDegrees>([^<]+)</g)].map((m) => (Number(m[1]) - 13).toFixed(3));
		expect(kept).toEqual(['0.003', '0.004', '0.003', '0.003', '0.004', '0.005', '0.006', '0.007']);
		// Hidden, visible, hidden, visible, hidden: five tracks in the lap.
		expect(tcx.match(/<Track>/g)).toHaveLength(5);
		expect(tcx).toContain(
			"</Lap><Notes>Start and end hidden (200 m) by Strava Bulk GPX Export - not Strava's original export.</Notes>",
		);
	});
});

/**
 * Run `expression` in the content script's isolated world, where
 * `chrome.storage` exists - the page's own world can't reach extension
 * storage. Used to plant stored state the UI can't produce on demand.
 */
async function evaluateInContentScript(page: Page, expression: string): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	const contexts: { id: number; origin: string }[] = [];
	cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
	await cdp.send('Runtime.enable');
	const world = contexts.find((c) => c.origin.startsWith('chrome-extension://'));
	if (!world) throw new Error('No content-script world on this page');
	const result = await cdp.send('Runtime.evaluate', { expression, contextId: world.id, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
	await cdp.detach();
}

/** A saved selection of the fixture's first two rows, `ageMs` old. */
function savedSelection(ageMs: number): string {
	const rows = [
		{ id: '9000000001', name: 'Traversa', sport_type: 'Trail Run', date: '2026-05-09', hasGps: true, columns: [] },
		// Saved before `date` and `hasGps` existed.
		{ id: '9000000002', name: 'Lunch Trail Run', sport_type: 'Trail Run', columns: [] },
		// Malformed: dropped.
		{ id: 'not-a-number', name: 'x', sport_type: '' },
	];
	return `chrome.storage.local.set({ selection: { savedAt: Date.now() - ${ageMs}, rows: ${JSON.stringify(rows)} } })`;
}

test.describe('saved selection', () => {
	test('is restored within a day, and malformed rows are dropped', async ({ extensionPage }) => {
		await evaluateInContentScript(extensionPage, savedSelection(23 * 60 * 60 * 1000));
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('2 selected');
		// Rows saved without `hasGps` count as GPS-bearing, so switching
		// format doesn't drop them.
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('2 selected');
	});

	test('is dropped when it is more than a day old', async ({ extensionPage }) => {
		await evaluateInContentScript(extensionPage, savedSelection(25 * 60 * 60 * 1000));
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('0 selected');
	});
});

test.describe('selecting across pages, edge cases', () => {
	test('without a pager, it selects the one page there is', async ({ extensionPage }) => {
		await extensionPage.locator('[data-role="select-pages"]').click();
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText('Added 3 activities from 1 pages.');
		await expect(extensionPage.locator('[data-role="select-pages"]')).toBeEnabled();
	});

	test('gives up on a page Strava never shows, keeping the selection', async ({ extensionPage }) => {
		// The 30-second page timeout runs out for real.
		test.setTimeout(60_000);
		await installFakePager(extensionPage, ['', fakeRowsHtml([{ id: '9000000006', sport: 'Ride', title: 'Loop' }])], 0, {
			delayMs: 120_000,
		});
		await extensionPage.locator('[data-role="select-pages"]').click();
		await expect(extensionPage.locator('[data-role="select-pages"]')).toBeDisabled();
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText(
			"Failed: Strava didn't load the next page",
			{ timeout: 40_000 },
		);
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText(/^3 selected/);
		await expect(extensionPage.locator('[data-role="select-pages"]')).toBeEnabled();
	});
});

test.describe('split zips, edge cases', () => {
	test('the split size is remembered, and Cancel keeps the parts already saved', async ({ extensionPage }) => {
		const split = extensionPage.locator('select[data-role="split"]');
		await extensionPage.locator('[data-role="more"] > summary').click();
		await split.selectOption('0');
		await extensionPage.reload();
		await extensionPage.waitForSelector('.sbgx-toolbar');
		await expect(split).toHaveValue('0');

		// One file per zip; the third activity never arrives.
		await extensionPage.locator('[data-role="more"] > summary').click();
		await split.evaluate((select: HTMLSelectElement) => {
			select.add(new Option('300 bytes', '0.0003'));
			select.value = '0.0003';
			select.dispatchEvent(new Event('change'));
		});
		await extensionPage.locator('[data-role="more"] > summary').click();
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await new Promise((r) => setTimeout(r, { '9000000001': 0, '9000000002': 300 }[id] ?? 10_000));
			await route
				.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxBody(id) })
				.catch(() => undefined);
		});
		const downloads: string[] = [];
		extensionPage.on('download', (d) => downloads.push(d.suggestedFilename()));

		await extensionPage.locator('.sbgx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		// The second file arriving fills part 1, which is saved.
		await expect.poll(() => downloads.length).toBe(1);
		await extensionPage.locator('[data-role="cancel"]').click();
		const status = extensionPage.locator('[data-role="status-text"]');
		await expect(status).toHaveText('Cancelled - 1 zip parts were already saved.');
		expect(downloads).toEqual([expect.stringMatching(/_part1\.zip$/)]);
		// Part 1's activity counts as exported; the others don't.
		await expect(extensionPage.locator('.sbgx-done').nth(0)).toBeVisible();
		await expect(extensionPage.locator('.sbgx-done').nth(1)).toBeHidden();
	});
});

test.describe('activities without GPS, row downloads', () => {
	test('an indoor row downloads its Original file; a manual entry says why it can’t', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*/export_original', async (route) => {
			const id = idFromUrl(route.request().url());
			if (id === '9000000005') {
				await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html></html>' });
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/octet-stream',
				headers: { 'Content-Disposition': `attachment; filename="${id}.fit"` },
				body: 'FIT',
			});
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		const indoor = extensionPage.locator('tr[data-sbgx-has-gps="0"] .sbgx-btn-row');
		const { name } = await downloadFrom(extensionPage, () => indoor.nth(0).click());
		expect(name).toBe('9000000004.fit');
		await expect(extensionPage.locator('tr[data-sbgx-id="9000000004"] .sbgx-done')).toBeVisible();

		// The row button reports failures with alert(); answer it here.
		const alerts: string[] = [];
		extensionPage.once('dialog', (dialog) => {
			alerts.push(dialog.message());
			void dialog.dismiss();
		});
		await indoor.nth(1).click();
		await expect
			.poll(() => alerts)
			.toEqual(["Couldn't download 9000000005: Strava has no Original file for this activity"]);
		// The page stayed where it was, rather than navigating to Strava's answer.
		await expect(extensionPage).toHaveURL('https://www.strava.com/athlete/training');
	});
});

test.describe('hide start/end in TCX, zips and merges', () => {
	/** {@link lineTcx} with a trackpoint without a position (a GPS dropout) after the fifth. */
	function tcxWithDropout(): string {
		return lineTcx(OUT_AND_BACK).replace(
			/(<Trackpoint>(?:(?!<\/Trackpoint>).)*<\/Trackpoint>){5}/,
			(m) =>
				`${m}<Trackpoint><Time>2026-05-09T07:04:30Z</Time><HeartRateBpm><Value>99</Value></HeartRateBpm></Trackpoint>`,
		);
	}

	test('zips and merges are trimmed and named so; a fully hidden track fails', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*/export_tcx', async (route) => {
			await route.fulfill({ status: 200, contentType: 'application/xml', body: tcxWithDropout() });
		});
		await extensionPage.locator('select[data-role="format"]').selectOption('tcx');
		await setTrim(extensionPage, '200');
		await extensionPage.locator('.sbgx-row-cb').nth(0).check();
		await extensionPage.locator('.sbgx-row-cb').nth(1).check();

		const { bytes } = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="bulk"]').click());
		expect(await zipFileNames(bytes)).toEqual([
			'activities.csv',
			'strava_9000000001_trimmed.tcx',
			'strava_9000000002_trimmed.tcx',
		]);
		const zip = await JSZip.loadAsync(bytes);
		const tcx = await zip.file('strava_9000000001_trimmed.tcx')!.async('string');
		await expectWellFormed(extensionPage, tcx);
		// The dropout point stays, with its heart rate, in the track it was in.
		expect(tcx).toContain('<Time>2026-05-09T07:04:30Z</Time><HeartRateBpm><Value>99</Value></HeartRateBpm>');
		expect(tcx.match(/<Trackpoint>/g)).toHaveLength(OUT_AND_BACK.length + 1);
		// Trimmed files aren't backups.
		await expect(extensionPage.locator('.sbgx-done').first()).toBeHidden();

		// Both activities have the same times, so they overlap: merge one.
		await extensionPage.locator('.sbgx-row-cb').nth(1).uncheck();
		const merged = await downloadFrom(extensionPage, () => extensionPage.locator('[data-role="merge"]').click());
		expect(merged.name).toMatch(/^strava_merged_\d{4}-\d{2}-\d{2}_trimmed\.tcx$/);
		expect(merged.bytes.toString('utf8')).toContain('Start and end hidden (200 m)');
		await expectWellFormed(extensionPage, merged.bytes.toString('utf8'));

		await setTrim(extensionPage, '1000');
		await extensionPage.locator('.sbgx-row-cb').nth(1).check();
		await extensionPage.locator('[data-role="bulk"]').click();
		await expect(extensionPage.locator('[data-role="status-text"]')).toHaveText(
			'Failed: All 2 downloads failed. First error: the whole track is within the hidden distance',
		);
	});
});

test.describe('hide start/end, custom distance', () => {
	test('takes a distance in the locale’s unit; switching the unit keeps the number', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*/export_gpx', async (route) => {
			const id = idFromUrl(route.request().url());
			await route.fulfill({ status: 200, contentType: 'application/gpx+xml', body: lineGpx(id, OUT_AND_BACK) });
		});
		const chip = extensionPage.locator('[data-role="trim-chip"]');
		const value = extensionPage.locator('[data-role="trim-value"]');
		const unit = extensionPage.locator('select[data-role="trim-unit"]');
		await extensionPage.locator('[data-role="more"] > summary').click();
		await expect(value).toBeHidden();
		await extensionPage.locator('select[data-role="trim"]').selectOption('custom');
		await expect(value).toBeFocused();
		// The test browser is en-US, which measures in feet.
		await expect(unit).toHaveValue('ft');
		// Nothing typed yet: nothing hidden.
		await expect(chip).toBeHidden();

		await value.fill('700');
		await expect(chip).toHaveText(/Hiding 700 ft at start and end/);
		await unit.selectOption('m');
		await expect(value).toHaveValue('700');
		await expect(chip).toHaveText(/Hiding 700 m at start and end/);

		// 700 ft is 213 m: the same points go as with 200 m.
		await unit.selectOption('ft');
		await extensionPage.locator('[data-role="more"] > summary').click();
		const { name, bytes } = await downloadFrom(extensionPage, () =>
			extensionPage.locator('.sbgx-btn-row').first().click(),
		);
		expect(name).toBe('strava_9000000001_trimmed.gpx');
		const gpx = bytes.toString('utf8');
		await expectWellFormed(extensionPage, gpx);
		const kept = [...gpx.matchAll(/lon="([^"]+)"/g)].map((m) => (Number(m[1]) - 13).toFixed(3));
		expect(kept).toEqual(['0.003', '0.004', '0.003', '0.003', '0.004', '0.005', '0.006', '0.007']);
		expect(gpx).toContain('Start and end hidden (213 m)');

		// Clearing the number turns hiding off; ✕ goes back to Off.
		await extensionPage.locator('[data-role="more"] > summary').click();
		await value.fill('');
		await expect(chip).toBeHidden();
		await value.fill('0');
		await expect(chip).toBeHidden();
		await value.fill('300');
		await expect(chip).toBeVisible();
		await extensionPage.locator('[data-role="trim-off"]').click();
		await expect(chip).toBeHidden();
		await expect(extensionPage.locator('select[data-role="trim"]')).toHaveValue('0');
		await expect(value).toBeHidden();

		// Original files aren't trimmed: the custom fields disable too. (The
		// ✕ sits outside the menu, so clicking it closed the menu.)
		await extensionPage.locator('[data-role="more"] > summary').click();
		await extensionPage.locator('select[data-role="trim"]').selectOption('custom');
		await extensionPage.locator('select[data-role="format"]').selectOption('original');
		await expect(value).toBeDisabled();
		await expect(unit).toBeDisabled();
	});
});
