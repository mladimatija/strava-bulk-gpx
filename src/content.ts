// Content script entry. Runs on https://www.strava.com/athlete/training* in
// the page's isolated world but with same-origin fetch capability - that's the
// magic that lets us call /activities/:id/export_gpx without any cookie wrangling.
//
// Strategy:
//   - Find the activities table (whatever React happens to have rendered).
//   - Mount a toolbar above it once.
//   - For each visible row, inject a checkbox at the start and a "GPX" button
//     at the end - but only when the row has GPS data (distance > 0).
//   - A MutationObserver re-runs the injection whenever Strava replaces the
//     table body (pagination, search, sort). Selection state survives via a
//     module-scope Set keyed by activity id.

import { downloadSingle, downloadBulk, downloadMergedGpx } from './downloader.ts';
import { KOFI_IMAGE } from './kofi-asset.ts';
import { t } from './i18n.ts';
import type { ActivityRow, ExportFormat, StatusKind } from './types.ts';

const KOFI_URL = 'https://ko-fi.com/D1D51ZGOQK';

/**
 * Escape user-supplied text before embedding it in an innerHTML template.
 * Translated strings come from Chrome's i18n system, which we control, but
 * being defensive keeps a future "wrong message file" pasted by a contributor
 * from breaking out of the attribute it lives in.
 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

interface State {
	selected: Set<string>;
	toolbar: HTMLDivElement | null;
	busy: boolean;
	/** Currently selected export format - drives per-row button text + URLs. */
	format: ExportFormat;
}

const STATE: State = {
	selected: new Set<string>(),
	toolbar: null,
	busy: false,
	format: 'gpx',
};

/** Human-readable label for a format, from the i18n bundle. */
function formatLabel(format: ExportFormat): string {
	if (format === 'gpx') return t('gpxButton');
	if (format === 'tcx') return t('formatTcx');
	return t('formatOriginal');
}

// ---------- DOM discovery ----------

/** Find the activities table by looking for any table that links to /activities/N. */
function findActivitiesTable(): HTMLTableElement | null {
	for (const table of document.querySelectorAll<HTMLTableElement>('table')) {
		if (table.querySelector('a[href*="/activities/"]')) return table;
	}
	return null;
}

/** Pull { id, name, sport_type } from a rendered table row, or null. */
function activityFromRow(row: HTMLTableRowElement): ActivityRow | null {
	const link = row.querySelector<HTMLAnchorElement>('a[href*="/activities/"]');
	if (!link) return null;
	const href = link.getAttribute('href');
	if (!href) return null;
	const m = /\/activities\/(\d+)/.exec(href);
	if (!m?.[1]) return null;
	const id = m[1];
	const name = (link.textContent ?? '').trim() || `Activity ${id}`;
	// Sport is usually the first <td> in the row. Best-effort, fine if missing.
	const sportCell = row.querySelector('td');
	const sport_type = sportCell ? (sportCell.textContent ?? '').trim() : '';
	return { id, name, sport_type };
}

/**
 * Heuristic: an activity has GPS if its distance cell shows a positive value.
 * Strava's My Activities table renders distance as "<number> km" / "<number> mi";
 * indoor or manually-entered workouts (Weight Training, Workout, etc.) show
 * "0 km" or omit the unit entirely. The regex matches both km and miles;
 * comma-thousands ("1,234 km") are stripped before parsing.
 */
function rowHasGps(row: HTMLTableRowElement): boolean {
	for (const td of row.querySelectorAll('td')) {
		const text = (td.textContent ?? '').trim();
		const m = /^([\d.,]+)\s*(km|mi)$/i.exec(text);
		if (!m?.[1]) continue;
		const value = parseFloat(m[1].replace(/,/g, ''));
		return Number.isFinite(value) && value > 0;
	}
	return false;
}

// ---------- Per-row injection ----------

function injectRow(row: HTMLTableRowElement): void {
	if (row.dataset.sbgxAugmented === '1') return;
	const a = activityFromRow(row);
	if (!a) return;
	row.dataset.sbgxAugmented = '1';
	row.dataset.sbgxId = a.id;

	const hasGps = rowHasGps(row);
	row.dataset.sbgxHasGps = hasGps ? '1' : '0';

	// Prepend a cell to keep column alignment even when there's no checkbox.
	const cbCell = document.createElement('td');
	cbCell.className = 'sbgx-cell sbgx-cell-check';
	if (hasGps) {
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.className = 'sbgx-row-cb';
		cb.checked = STATE.selected.has(a.id);
		cb.addEventListener('change', () => {
			if (cb.checked) STATE.selected.add(a.id);
			else STATE.selected.delete(a.id);
			onSelectionChanged();
		});
		cbCell.appendChild(cb);
	}
	row.insertBefore(cbCell, row.firstChild);

	// Always append the trailing cell, but only render a button when GPS exists.
	const dlCell = document.createElement('td');
	dlCell.className = 'sbgx-cell sbgx-cell-dl';
	if (hasGps) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'sbgx-btn sbgx-btn-primary sbgx-btn-row';
		btn.textContent = formatLabel(STATE.format);
		btn.title = t('rowButtonTitle', formatLabel(STATE.format));
		btn.addEventListener('click', async (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (btn.disabled) return;
			btn.disabled = true;
			const old = btn.textContent ?? formatLabel(STATE.format);
			btn.textContent = '…';
			try {
				// Read the format from STATE at click time so changing the
				// selector after rendering immediately affects what gets fetched.
				await downloadSingle(a, STATE.format);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				alert(t('rowDownloadFailed', [a.id, message]));
			} finally {
				btn.disabled = false;
				btn.textContent = old;
			}
		});
		dlCell.appendChild(btn);
	}
	row.appendChild(dlCell);
}

function injectAllRows(table: HTMLTableElement): void {
	table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach(injectRow);
}

// ---------- Toolbar ----------

function buildToolbar(): HTMLDivElement {
	const toolbar = document.createElement('div');
	toolbar.className = 'sbgx-toolbar';
	const koFiLabel = escapeHtml(t('koFiTitle'));
	toolbar.innerHTML = `
      <label class="sbgx-tool sbgx-select-all">
        <input type="checkbox" class="sbgx-select-all-cb" />
        <span>${escapeHtml(t('selectAllVisible'))}</span>
      </label>
      <label class="sbgx-tool sbgx-format-wrap">
        <span>${escapeHtml(t('formatLabel'))}</span>
        <select class="sbgx-format" data-role="format">
          <option value="gpx">${escapeHtml(t('gpxButton'))}</option>
          <option value="tcx">${escapeHtml(t('formatTcx'))}</option>
          <option value="original">${escapeHtml(t('formatOriginal'))}</option>
        </select>
      </label>
      <button class="sbgx-btn sbgx-btn-primary" data-role="bulk" disabled>${escapeHtml(t('downloadSelected'))}</button>
      <button class="sbgx-btn sbgx-btn-secondary" data-role="merge" disabled>${escapeHtml(t('mergeSelected'))}</button>
      <span class="sbgx-tool sbgx-count" data-role="count">${escapeHtml(t('selectedCount', '0'))}</span>
      <span class="sbgx-tool sbgx-status" data-role="status">
        <span class="sbgx-spinner" data-role="spinner" hidden></span>
        <span class="sbgx-status-text" data-role="status-text"></span>
      </span>
      <span class="sbgx-spacer"></span>
      <a class="sbgx-kofi" href="${KOFI_URL}" target="_blank" rel="noopener" title="${koFiLabel}">
        <img src="${KOFI_IMAGE}" alt="${koFiLabel}" />
      </a>
    `;

	const selectAll = toolbar.querySelector<HTMLInputElement>('.sbgx-select-all-cb')!;
	selectAll.addEventListener('change', () => {
		const want = selectAll.checked;
		// Only operate on GPS-bearing rows - others don't have a checkbox.
		for (const cb of document.querySelectorAll<HTMLInputElement>('.sbgx-row-cb')) {
			const id = cb.closest<HTMLTableRowElement>('tr')?.dataset.sbgxId;
			if (!id) continue;
			cb.checked = want;
			if (want) STATE.selected.add(id);
			else STATE.selected.delete(id);
		}
		onSelectionChanged();
	});

	const bulkBtn = toolbar.querySelector<HTMLButtonElement>('[data-role="bulk"]')!;
	bulkBtn.addEventListener('click', handleBulkClick);

	const mergeBtn = toolbar.querySelector<HTMLButtonElement>('[data-role="merge"]')!;
	mergeBtn.addEventListener('click', handleMergeClick);

	const formatSelect = toolbar.querySelector<HTMLSelectElement>('[data-role="format"]')!;
	formatSelect.value = STATE.format;
	formatSelect.addEventListener('change', () => {
		// Tolerate unexpected values defensively; if someone hacks the DOM in
		// devtools we still fall back to gpx rather than crashing later.
		const next = formatSelect.value;
		STATE.format = next === 'tcx' || next === 'original' ? next : 'gpx';
		refreshRowButtons();
		// renderToolbarCounts re-derives the merge button's disabled/title
		// state from STATE.format, so it has to run on every format change.
		renderToolbarCounts();
	});
	return toolbar;
}

/**
 * Walk every injected per-row GPX button and update its visible text + title
 * to match the currently selected format. Called when the format select
 * changes - the click handlers themselves already read STATE.format at click
 * time, so this is purely a labeling refresh.
 */
function refreshRowButtons(): void {
	const label = formatLabel(STATE.format);
	const title = t('rowButtonTitle', label);
	for (const btn of document.querySelectorAll<HTMLButtonElement>('.sbgx-btn-row')) {
		// Don't clobber the "…" spinner state of a button that's currently
		// downloading; the click handler restores the right label in its
		// "finally" block.
		if (!btn.disabled) btn.textContent = label;
		btn.title = title;
	}
}

function ensureToolbar(table: HTMLTableElement): HTMLDivElement | null {
	if (STATE.toolbar && document.contains(STATE.toolbar)) return STATE.toolbar;
	const parent = table.parentElement;
	if (!parent) return null;
	const tb = buildToolbar();
	parent.insertBefore(tb, table);
	STATE.toolbar = tb;
	return tb;
}

function renderToolbarCounts(): void {
	if (!STATE.toolbar) return;
	// Only GPS-bearing rows are selectable, so only count those for both
	// the "X selected" text and the "select all" indeterminate state.
	const selectableIds = new Set<string>();
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbgx-has-gps="1"]')) {
		const id = row.dataset.sbgxId;
		if (id) selectableIds.add(id);
	}
	let visibleSelected = 0;
	for (const id of STATE.selected) if (selectableIds.has(id)) visibleSelected++;

	const countEl = STATE.toolbar.querySelector<HTMLElement>('[data-role="count"]')!;
	const bulkBtn = STATE.toolbar.querySelector<HTMLButtonElement>('[data-role="bulk"]')!;
	const mergeBtn = STATE.toolbar.querySelector<HTMLButtonElement>('[data-role="merge"]')!;
	countEl.textContent = t('selectedCount', String(visibleSelected));
	bulkBtn.disabled = visibleSelected === 0 || STATE.busy;
	// Merge is GPX-only - TCX and Original files aren't trivially concatenable
	// into one document. Rather than hide the button silently (which leaves
	// users wondering where it went after switching format), keep it visible
	// but disabled, with a tooltip explaining the constraint. Easier to learn.
	//
	// Use setAttribute/removeAttribute explicitly - setting `.title = ''` is
	// inconsistent across Chromium versions about whether the empty `title`
	// attribute lingers in the DOM, which trips up attribute-based assertions
	// in the e2e suite.
	const mergeAvailable = STATE.format === 'gpx';
	mergeBtn.disabled = !mergeAvailable || visibleSelected === 0 || STATE.busy;
	if (mergeAvailable) {
		mergeBtn.removeAttribute('title');
	} else {
		mergeBtn.setAttribute('title', t('mergeOnlyGpx'));
	}

	const allCb = STATE.toolbar.querySelector<HTMLInputElement>('.sbgx-select-all-cb')!;
	if (selectableIds.size === 0) {
		allCb.checked = false;
		allCb.indeterminate = false;
	} else {
		allCb.checked = visibleSelected === selectableIds.size;
		allCb.indeterminate = visibleSelected > 0 && visibleSelected < selectableIds.size;
	}
}

/**
 * Update the toolbar status line.
 *
 * @param text     What to display. Pass "" to clear.
 * @param kind     Drives color (info | ok | warn | err).
 * @param spinner  Show the inline spinner; always false when terminal.
 */
function setStatus(text: string, kind: StatusKind = '', { spinner = false }: { spinner?: boolean } = {}): void {
	if (!STATE.toolbar) return;
	const container = STATE.toolbar.querySelector<HTMLElement>('[data-role="status"]')!;
	const textEl = container.querySelector<HTMLElement>('[data-role="status-text"]')!;
	const spinnerEl = container.querySelector<HTMLElement>('[data-role="spinner"]')!;
	textEl.textContent = text;
	container.dataset.kind = kind;
	spinnerEl.hidden = !spinner;
}

/**
 * Reflect STATE.selected onto every rendered checkbox. Important when two
 * rows share an id (sticky header mirror, etc.) - without this, checking one
 * would leave the duplicate visibly unchecked.
 */
function syncRowCheckboxes(): void {
	for (const cb of document.querySelectorAll<HTMLInputElement>('.sbgx-row-cb')) {
		const id = cb.closest<HTMLTableRowElement>('tr')?.dataset.sbgxId;
		if (id) cb.checked = STATE.selected.has(id);
	}
}

/**
 * User-initiated selection change. Clears any leftover post-download status
 * (e.g. "Saved 4 activities.") so the toolbar reflects only the current
 * intent, but leaves in-progress download messages alone.
 */
function onSelectionChanged(): void {
	syncRowCheckboxes();
	if (!STATE.busy) setStatus('');
	renderToolbarCounts();
}

/**
 * Build the activity list from currently visible rows that are in the
 * selected set. Dedupes by activity id - Strava sometimes renders more than
 * one <tr> per activity (sticky header mirror, transient rows during
 * pagination), and both would otherwise inflate the count.
 */
function collectSelectedActivities(): ActivityRow[] {
	const seen = new Set<string>();
	const activities: ActivityRow[] = [];
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbgx-id]')) {
		const id = row.dataset.sbgxId;
		if (!id || !STATE.selected.has(id) || seen.has(id)) continue;
		seen.add(id);
		const a = activityFromRow(row);
		if (a) activities.push(a);
	}
	return activities;
}

async function handleBulkClick(): Promise<void> {
	if (STATE.busy) return;
	const activities = collectSelectedActivities();
	if (activities.length === 0) return;

	STATE.busy = true;
	renderToolbarCounts();
	setStatus(t('preparingDownloads', String(activities.length)), 'info', { spinner: true });
	try {
		const result = await downloadBulk(activities, STATE.format, {
			onProgress: (ev) => {
				if (ev.stage === 'downloading') {
					setStatus(t('downloadingProgress', [String(ev.completed), String(ev.total)]), 'info', { spinner: true });
				} else if (ev.stage === 'zipping') {
					setStatus(t('buildingZip'), 'info', { spinner: true });
				}
			},
		});
		const firstFailed = result.failed[0];
		const note = firstFailed
			? t('savedWithSkips', [String(result.ok), String(result.failed.length), firstFailed.reason])
			: t('savedActivities', String(result.ok));
		setStatus(note, firstFailed ? 'warn' : 'ok');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		setStatus(t('downloadFailed', message), 'err');
	} finally {
		STATE.busy = false;
		renderToolbarCounts();
	}
}

/**
 * Merge-mode bulk handler. Reuses the same fetch concurrency as
 * {@link handleBulkClick} but emits a single combined .gpx instead of a zip
 * of per-activity files. Only sensible when STATE.format === 'gpx'; the
 * button is hidden otherwise, but we still gate defensively in case the user
 * clicked between format changes.
 */
async function handleMergeClick(): Promise<void> {
	if (STATE.busy) return;
	if (STATE.format !== 'gpx') return;
	const activities = collectSelectedActivities();
	if (activities.length === 0) return;

	STATE.busy = true;
	renderToolbarCounts();
	setStatus(t('preparingDownloads', String(activities.length)), 'info', { spinner: true });
	try {
		const result = await downloadMergedGpx(activities, {
			onProgress: (ev) => {
				if (ev.stage === 'downloading') {
					setStatus(t('downloadingProgress', [String(ev.completed), String(ev.total)]), 'info', { spinner: true });
				} else if (ev.stage === 'merging') {
					setStatus(t('mergingGpx'), 'info', { spinner: true });
				}
			},
		});
		const firstFailed = result.failed[0];
		const note = firstFailed
			? t('savedWithSkips', [String(result.ok), String(result.failed.length), firstFailed.reason])
			: t('savedMerged', String(result.ok));
		setStatus(note, firstFailed ? 'warn' : 'ok');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		setStatus(t('downloadFailed', message), 'err');
	} finally {
		STATE.busy = false;
		renderToolbarCounts();
	}
}

// ---------- Boot + observer ----------

function tick(): void {
	const table = findActivitiesTable();
	if (!table) return;
	ensureToolbar(table);
	injectAllRows(table);
	renderToolbarCounts();
}

function start(): void {
	tick();
	// Strava's React reflows the table on every search / sort / pagination.
	// A single observer on the body handles all of it; the injection helpers
	// are idempotent.
	const obs = new MutationObserver(() => {
		// De-bounce: bunch of mutations during a re-render - wait a frame.
		requestAnimationFrame(tick);
	});
	obs.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
