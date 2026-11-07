// E2E behavior tests. Each test starts from a fresh fixture page with the
// content script already mounted (see tests/fixtures/extension.ts).

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
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

/** Sorted file paths inside a zip (folder entries left out). */
async function zipFileNames(bytes: Buffer): Promise<string[]> {
	const zip = await JSZip.loadAsync(bytes);
	return Object.values(zip.files)
		.filter((f) => !f.dir)
		.map((f) => f.name)
		.sort();
}

interface FakeRow {
	id: string;
	sport: string;
	title: string;
}

/**
 * Simulate Strava paginating: swap the table body for other activities, the
 * way its React re-render does, and wait for the extension to augment them.
 */
async function showOtherPage(page: Page, rows: FakeRow[]): Promise<void> {
	await page.evaluate((fakeRows) => {
		document.querySelector('tbody')!.innerHTML = fakeRows
			.map(
				(r) =>
					`<tr><td>${r.sport}</td><td>Mon, 04/05/2026</td><td><a href="/activities/${r.id}">${r.title}</a></td>` +
					`<td class="num">30:00</td><td class="num">5.00 km</td><td class="num">20 m</td><td class="num">5</td>` +
					`<td class="row-actions"><a href="#">Edit</a></td></tr>`,
			)
			.join('');
	}, rows);
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
		// two of these three files would vanish from the archive.
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
		expect(await zipFileNames(bytes)).toEqual(['activity-2.fit', 'activity-3.fit', 'activity.fit']);
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
