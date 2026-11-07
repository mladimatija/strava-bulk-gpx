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
//     module-scope Map keyed by activity id, so a selection can span pages.

import { downloadSingle, downloadBulk, downloadMerged, downloadActivitiesCsv, type BulkOptions } from './downloader.ts';
import { activityIdsFromCsv } from './csv.ts';
import { clearHistory, exportedAt, exportedTotal, loadHistory, recordExports } from './history.ts';
import { KOFI_IMAGE } from './kofi-asset.ts';
import { t } from './i18n.ts';
import type {
	ActivityColumn,
	ActivityRow,
	ExportFormat,
	MergeMode,
	NamePattern,
	ProgressEvent,
	StatusKind,
} from './types.ts';

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

/** An activity that failed in the last run, with the reason shown to the user. */
interface FailedActivity {
	activity: ActivityRow;
	reason: string;
}

interface State {
	/**
	 * Selected activities by id. Kept across Strava's pagination and searches,
	 * so a selection can span pages; the row data is captured at selection
	 * time because off-page rows aren't in the DOM to re-read.
	 */
	selected: Map<string, ActivityRow>;
	toolbar: HTMLDivElement | null;
	busy: boolean;
	/** Currently selected export format - drives per-row button text + URLs. */
	format: ExportFormat;
	/** How downloaded files are named. */
	names: NamePattern;
	/** How a GPX merge combines activities (a TCX merge always makes one). */
	mergeMode: MergeMode;
	/**
	 * Hide start/end radius in metres, 0 = off. Deliberately not saved: a
	 * remembered trim would silently alter later archive backups, so it
	 * resets on every page load and shows a toolbar chip while on.
	 */
	trim: number;
	/** Aborts the in-flight bulk/merge run; null when idle. */
	abort: AbortController | null;
	/**
	 * Failures from the last run, listed under the toolbar. `retryFormat` is
	 * set for zip runs (retrying fetches only the failed ones); merge runs
	 * leave it null - re-merging just the failures would drop the rest.
	 */
	lastRun: { failed: FailedActivity[]; retryFormat: ExportFormat | null } | null;
	/** Row last toggled - the anchor for shift-click range selection. */
	anchorId: string | null;
}

const STATE: State = {
	selected: new Map<string, ActivityRow>(),
	toolbar: null,
	busy: false,
	format: 'gpx',
	names: 'id',
	mergeMode: 'tracks',
	trim: 0,
	abort: null,
	lastRun: null,
	anchorId: null,
};

const FORMAT_STORAGE_KEY = 'exportFormat';
const NAMES_STORAGE_KEY = 'namePattern';
const MERGE_MODE_STORAGE_KEY = 'mergeMode';

/** Narrow an untrusted stored value to a known format, defaulting to gpx. */
function parseFormat(value: unknown): ExportFormat {
	return value === 'tcx' || value === 'original' ? value : 'gpx';
}

/** Narrow an untrusted stored value to a known name pattern, defaulting to id. */
function parseNames(value: unknown): NamePattern {
	return value === 'title' || value === 'sport' ? value : 'id';
}

/** Narrow an untrusted stored value to a known merge mode, defaulting to tracks. */
function parseMergeMode(value: unknown): MergeMode {
	return value === 'single' ? value : 'tracks';
}

/** Hide start/end radii offered in the "⋯" menu, in metres. */
const TRIM_RADII = [200, 500, 1000];

/** Narrow a trim select value to an offered radius, or 0 (off). */
function parseTrim(value: string): number {
	const radius = Number(value);
	return TRIM_RADII.includes(radius) ? radius : 0;
}

/** "200 m", "1 km". */
function radiusLabel(metres: number): string {
	return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}

/** The trim radius that applies right now - trimming is GPX-only. */
function effectiveTrim(): number {
	return STATE.format === 'gpx' ? STATE.trim : 0;
}

/** Restore the last-used format and name pattern; storage failures keep the defaults. */
async function loadPreferences(): Promise<void> {
	try {
		const stored = await chrome.storage.local.get([FORMAT_STORAGE_KEY, NAMES_STORAGE_KEY, MERGE_MODE_STORAGE_KEY]);
		STATE.format = parseFormat(stored[FORMAT_STORAGE_KEY]);
		STATE.names = parseNames(stored[NAMES_STORAGE_KEY]);
		STATE.mergeMode = parseMergeMode(stored[MERGE_MODE_STORAGE_KEY]);
	} catch {
		// Keep the defaults - a broken storage area shouldn't block exports.
	}
}

/** Persist a toolbar preference for the next page load (best-effort). */
function savePreference(key: string, value: string): void {
	chrome.storage.local.set({ [key]: value }).catch((err: unknown) => {
		console.warn(`Could not save ${key}`, err);
	});
}

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

/**
 * The row's visible cells, labelled by the table's header. Our injected
 * cells are skipped, and so are columns with an empty header (Strava's
 * Edit / Share actions). Without a header row, columns are numbered.
 */
function rowColumns(row: HTMLTableRowElement): ActivityColumn[] {
	const headerRow = row.closest('table')?.tHead?.rows[0];
	const headers = headerRow ? Array.from(headerRow.cells).filter((th) => !th.classList.contains('sbgx-cell')) : null;
	const cells = Array.from(row.cells).filter((td) => !td.classList.contains('sbgx-cell'));
	const columns: ActivityColumn[] = [];
	cells.forEach((td, i) => {
		const label = headers ? (headers[i]?.textContent ?? '').trim() : String(i + 1);
		if (!label) return;
		columns.push({ label, value: (td.textContent ?? '').trim().replace(/\s+/g, ' ') });
	});
	return columns;
}

/** Pull { id, name, sport_type, columns } from a rendered table row, or null. */
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
	const sportCell = Array.from(row.cells).find((td) => !td.classList.contains('sbgx-cell'));
	const sport_type = sportCell ? (sportCell.textContent ?? '').trim() : '';
	return { id, name, sport_type, columns: rowColumns(row) };
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

/**
 * Selectable rows currently on screen, in table order, one per activity id
 * (Strava sometimes renders a sticky-header mirror or a transient duplicate
 * `<tr>` for the same activity).
 */
function visibleSelectableRows(): HTMLTableRowElement[] {
	const seen = new Set<string>();
	const rows: HTMLTableRowElement[] = [];
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbgx-has-gps="1"]')) {
		const id = row.dataset.sbgxId;
		if (!id || seen.has(id)) continue;
		seen.add(id);
		rows.push(row);
	}
	return rows;
}

// ---------- Selection ----------

function setSelected(activity: ActivityRow, selected: boolean): void {
	if (selected) STATE.selected.set(activity.id, activity);
	else STATE.selected.delete(activity.id);
}

/**
 * Shift-click: set every visible row between the anchor and the clicked row
 * (inclusive, in table order) to the clicked checkbox's new state. Returns
 * false when the anchor isn't on this page, so the caller falls back to a
 * plain toggle.
 */
function selectRange(fromId: string, toId: string, selected: boolean): boolean {
	const rows = visibleSelectableRows();
	const ids = rows.map((row) => row.dataset.sbgxId);
	const from = ids.indexOf(fromId);
	const to = ids.indexOf(toId);
	if (from === -1 || to === -1) return false;
	for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
		const a = activityFromRow(row);
		if (a) setSelected(a, selected);
	}
	return true;
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
		// `click` rather than `change`: only the click event carries shiftKey.
		// Keyboard toggles (Space) dispatch a click too.
		cb.addEventListener('click', (e: MouseEvent) => {
			const anchor = STATE.anchorId;
			const ranged = e.shiftKey && anchor !== null && anchor !== a.id && selectRange(anchor, a.id, cb.checked);
			if (!ranged) setSelected(a, cb.checked);
			// Shift-click also extends the browser's text selection across the
			// table; drop it so the page doesn't flash blue.
			if (e.shiftKey) window.getSelection()?.removeAllRanges();
			STATE.anchorId = a.id;
			onSelectionChanged();
		});
		cbCell.appendChild(cb);
	}
	row.insertBefore(cbCell, row.firstChild);

	// Always append the trailing cell, but only render a button when GPS exists.
	const dlCell = document.createElement('td');
	dlCell.className = 'sbgx-cell sbgx-cell-dl';
	if (hasGps) {
		const done = document.createElement('span');
		done.className = 'sbgx-done';
		done.textContent = '✓';
		renderExportBadge(done, a.id);
		dlCell.appendChild(done);

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
			// Read the format from STATE at click time so changing the
			// selector after rendering immediately affects what gets fetched.
			const format = STATE.format;
			const trim = effectiveTrim();
			try {
				await downloadSingle(a, format, STATE.names, trim);
				// A trimmed file isn't a backup of the activity.
				if (trim === 0) rememberExports([a.id], format);
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

/**
 * Give the header row cells matching the ones injectRow adds to each body
 * row: a leading checkbox column and a trailing button column. Strava's
 * table uses `table-layout: fixed`, which sizes columns from the header
 * row - without these, every data cell sat one column right of its header.
 * Checked per cell rather than flagged per row, so it also recovers if
 * Strava re-renders the header cells in place.
 */
function injectHeader(table: HTMLTableElement): void {
	for (const row of Array.from(table.tHead?.rows ?? [])) {
		if (!row.querySelector(':scope > .sbgx-cell-check')) {
			const th = document.createElement('th');
			th.className = 'sbgx-cell sbgx-cell-check';
			row.insertBefore(th, row.firstChild);
		}
		if (!row.querySelector(':scope > .sbgx-cell-dl')) {
			const th = document.createElement('th');
			th.className = 'sbgx-cell sbgx-cell-dl';
			row.appendChild(th);
		}
	}
}

function injectAllRows(table: HTMLTableElement): void {
	table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach(injectRow);
}

// ---------- Toolbar ----------

/** Look up one of the toolbar's `data-role` elements. */
function toolbarPart<T extends HTMLElement>(toolbar: HTMLElement, role: string): T {
	return toolbar.querySelector<T>(`[data-role="${role}"]`)!;
}

function buildToolbar(): HTMLDivElement {
	const toolbar = document.createElement('div');
	toolbar.className = 'sbgx-toolbar';
	const koFiLabel = escapeHtml(t('koFiTitle'));
	toolbar.innerHTML = `
      <label class="sbgx-tool sbgx-select-all">
        <input type="checkbox" class="sbgx-select-all-cb" />
        <span>${escapeHtml(t('selectAllVisible'))}</span>
      </label>
      <button class="sbgx-btn sbgx-btn-link" data-role="select-new">${escapeHtml(t('selectNew'))}</button>
      <label class="sbgx-tool sbgx-format-wrap">
        <span>${escapeHtml(t('formatLabel'))}</span>
        <select class="sbgx-format" data-role="format">
          <option value="gpx">${escapeHtml(t('gpxButton'))}</option>
          <option value="tcx">${escapeHtml(t('formatTcx'))}</option>
          <option value="original">${escapeHtml(t('formatOriginal'))}</option>
        </select>
      </label>
      <label class="sbgx-tool sbgx-format-wrap" title="${escapeHtml(t('namesTooltip'))}">
        <span>${escapeHtml(t('namesLabel'))}</span>
        <select class="sbgx-format" data-role="names">
          <option value="id">${escapeHtml(t('namesId'))}</option>
          <option value="title">${escapeHtml(t('namesTitle'))}</option>
          <option value="sport">${escapeHtml(t('namesSport'))}</option>
        </select>
      </label>
      <button class="sbgx-btn sbgx-btn-primary" data-role="bulk" disabled>${escapeHtml(t('downloadSelected'))}</button>
      <button class="sbgx-btn sbgx-btn-secondary" data-role="merge" disabled>${escapeHtml(t('mergeSelected'))}</button>
      <button class="sbgx-btn" data-role="csv" disabled>${escapeHtml(t('exportCsv'))}</button>
      <details class="sbgx-more" data-role="more">
        <summary class="sbgx-btn" title="${escapeHtml(t('moreOptions'))}">⋯</summary>
        <div class="sbgx-menu">
          <label class="sbgx-menu-field">
            <span class="sbgx-menu-heading">${escapeHtml(t('mergeModeLabel'))}</span>
            <select class="sbgx-format" data-role="merge-mode">
              <option value="tracks">${escapeHtml(t('mergeModeTracks'))}</option>
              <option value="single">${escapeHtml(t('mergeModeSingle'))}</option>
            </select>
          </label>
          <label class="sbgx-menu-field" title="${escapeHtml(t('trimTitle'))}">
            <span class="sbgx-menu-heading">${escapeHtml(t('trimLabel'))}</span>
            <select class="sbgx-format" data-role="trim">
              <option value="0">${escapeHtml(t('trimOff'))}</option>
              ${TRIM_RADII.map((r) => `<option value="${r}">${radiusLabel(r)}</option>`).join('')}
            </select>
          </label>
          <span class="sbgx-menu-heading">${escapeHtml(t('historyHeading'))}</span>
          <button class="sbgx-btn" data-role="history-import"></button>
          <input type="file" accept=".csv,text/csv" data-role="history-file" hidden />
          <button class="sbgx-btn" data-role="history-forget">${escapeHtml(t('historyForget'))}</button>
        </div>
      </details>
      <button class="sbgx-btn" data-role="cancel" hidden>${escapeHtml(t('cancel'))}</button>
      <span class="sbgx-tool sbgx-count" data-role="count">${escapeHtml(t('selectedCount', '0'))}</span>
      <button class="sbgx-btn sbgx-btn-link" data-role="clear" hidden>${escapeHtml(t('clearSelection'))}</button>
      <span class="sbgx-tool sbgx-trim-chip" data-role="trim-chip" hidden>
        <span data-role="trim-chip-text"></span>
        <button class="sbgx-trim-off" data-role="trim-off" title="${escapeHtml(t('trimTurnOff'))}">✕</button>
      </span>
      <span class="sbgx-tool sbgx-status" data-role="status">
        <span class="sbgx-spinner" data-role="spinner" hidden></span>
        <span class="sbgx-status-text" data-role="status-text"></span>
      </span>
      <span class="sbgx-spacer"></span>
      <a class="sbgx-kofi" href="${KOFI_URL}" target="_blank" rel="noopener" title="${koFiLabel}">
        <img src="${KOFI_IMAGE}" alt="${koFiLabel}" />
      </a>
      <div class="sbgx-failures" data-role="failures" hidden>
        <button class="sbgx-btn" data-role="retry"></button>
        <details>
          <summary>${escapeHtml(t('showFailures'))}</summary>
          <ul data-role="failures-list"></ul>
        </details>
      </div>
    `;

	const selectAll = toolbar.querySelector<HTMLInputElement>('.sbgx-select-all-cb')!;
	selectAll.addEventListener('change', () => {
		// Only operate on GPS-bearing rows on this page - others don't have a
		// checkbox, and off-page selections stay as they are.
		for (const row of visibleSelectableRows()) {
			const a = activityFromRow(row);
			if (a) setSelected(a, selectAll.checked);
		}
		onSelectionChanged();
	});

	toolbarPart(toolbar, 'select-new').addEventListener('click', () => {
		// Adds to the selection; activities already exported in the current
		// format, and off-page picks, stay as they are.
		for (const row of visibleSelectableRows()) {
			const id = row.dataset.sbgxId;
			if (!id || exportedAt(id, STATE.format) !== null) continue;
			const a = activityFromRow(row);
			if (a) setSelected(a, true);
		}
		onSelectionChanged();
	});

	toolbarPart(toolbar, 'bulk').addEventListener('click', handleBulkClick);
	toolbarPart(toolbar, 'merge').addEventListener('click', handleMergeClick);
	toolbarPart(toolbar, 'csv').addEventListener('click', handleCsvClick);
	toolbarPart(toolbar, 'cancel').addEventListener('click', () => STATE.abort?.abort());
	toolbarPart(toolbar, 'retry').addEventListener('click', handleRetryClick);
	toolbarPart(toolbar, 'clear').addEventListener('click', () => {
		STATE.selected.clear();
		STATE.anchorId = null;
		onSelectionChanged();
	});

	const formatSelect = toolbarPart<HTMLSelectElement>(toolbar, 'format');
	formatSelect.value = STATE.format;
	formatSelect.addEventListener('change', () => {
		// Tolerate unexpected values defensively; if someone hacks the DOM in
		// devtools we still fall back to gpx rather than crashing later.
		const next = formatSelect.value;
		STATE.format = parseFormat(next);
		savePreference(FORMAT_STORAGE_KEY, STATE.format);
		refreshRowButtons();
		renderExportBadges();
		// renderToolbarCounts re-derives the merge button's disabled/title
		// state from STATE.format, so it has to run on every format change.
		renderToolbarCounts();
	});

	const namesSelect = toolbarPart<HTMLSelectElement>(toolbar, 'names');
	namesSelect.value = STATE.names;
	namesSelect.addEventListener('change', () => {
		STATE.names = parseNames(namesSelect.value);
		savePreference(NAMES_STORAGE_KEY, STATE.names);
	});

	wireMoreMenu(toolbar);
	return toolbar;
}

/**
 * The "⋯" menu holds settings and actions that are rarely touched: how GPX
 * merges combine activities; hiding the start/end of GPX tracks (whose chip
 * sits on the toolbar, so it can't go unnoticed); and export history -
 * marking activities from an earlier CSV as exported (so existing users
 * don't start with everything "new"), and forgetting the history.
 */
function wireMoreMenu(toolbar: HTMLDivElement): void {
	const more = toolbarPart<HTMLDetailsElement>(toolbar, 'more');
	document.addEventListener('click', (e) => {
		if (more.open && !more.contains(e.target as Node)) more.open = false;
	});

	const mergeModeSelect = toolbarPart<HTMLSelectElement>(toolbar, 'merge-mode');
	mergeModeSelect.value = STATE.mergeMode;
	mergeModeSelect.addEventListener('change', () => {
		STATE.mergeMode = parseMergeMode(mergeModeSelect.value);
		savePreference(MERGE_MODE_STORAGE_KEY, STATE.mergeMode);
		renderToolbarCounts();
	});

	const trimSelect = toolbarPart<HTMLSelectElement>(toolbar, 'trim');
	trimSelect.value = String(STATE.trim);
	trimSelect.addEventListener('change', () => {
		STATE.trim = parseTrim(trimSelect.value);
		renderToolbarCounts();
	});
	toolbarPart(toolbar, 'trim-off').addEventListener('click', () => {
		STATE.trim = 0;
		trimSelect.value = '0';
		renderToolbarCounts();
	});

	const fileInput = toolbarPart<HTMLInputElement>(toolbar, 'history-file');
	toolbarPart(toolbar, 'history-import').addEventListener('click', () => fileInput.click());
	fileInput.addEventListener('change', async () => {
		const file = fileInput.files?.[0];
		fileInput.value = '';
		if (!file) return;
		more.open = false;
		const format = STATE.format;
		try {
			const ids = activityIdsFromCsv(await file.text());
			if (ids.length === 0) {
				setStatus(t('historyImportEmpty'), 'warn');
				return;
			}
			await recordExports(ids, format);
			renderExportBadges();
			renderToolbarCounts();
			setStatus(t('historyImported', [String(ids.length), formatLabel(format)]), 'ok');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setStatus(t('downloadFailed', message), 'err');
		}
	});

	// Forgetting is irreversible, so it takes a second click within a few
	// seconds - an inline confirmation instead of a blocking confirm() dialog.
	const forgetBtn = toolbarPart<HTMLButtonElement>(toolbar, 'history-forget');
	let disarmTimer: number | undefined;
	const disarm = (): void => {
		window.clearTimeout(disarmTimer);
		delete forgetBtn.dataset.armed;
		forgetBtn.textContent = t('historyForget');
	};
	forgetBtn.addEventListener('click', async () => {
		if (forgetBtn.dataset.armed !== '1') {
			forgetBtn.dataset.armed = '1';
			forgetBtn.textContent = t('historyForgetConfirm');
			disarmTimer = window.setTimeout(disarm, 4000);
			return;
		}
		disarm();
		more.open = false;
		try {
			await clearHistory();
			renderExportBadges();
			renderToolbarCounts();
			setStatus(t('historyForgotten'), 'ok');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setStatus(t('downloadFailed', message), 'err');
		}
	});
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
	renderFailures();
	return tb;
}

function renderToolbarCounts(): void {
	if (!STATE.toolbar) return;
	// The "select all" state only concerns this page's selectable rows; the
	// count and the action buttons cover the whole selection, wherever it is.
	const visibleIds = visibleSelectableRows().map((row) => row.dataset.sbgxId);
	const visibleSelected = visibleIds.filter((id) => id && STATE.selected.has(id)).length;
	const total = STATE.selected.size;
	const offPage = total - visibleSelected;

	const countEl = toolbarPart(STATE.toolbar, 'count');
	const bulkBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'bulk');
	const mergeBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'merge');
	const csvBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'csv');
	const clearBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'clear');
	countEl.textContent =
		offPage > 0 ? t('selectedCountWithHidden', [String(total), String(offPage)]) : t('selectedCount', String(total));
	bulkBtn.disabled = total === 0 || STATE.busy;
	csvBtn.disabled = total === 0 || STATE.busy;
	clearBtn.hidden = total === 0;
	clearBtn.disabled = STATE.busy;
	toolbarPart(STATE.toolbar, 'cancel').hidden = !STATE.busy;

	// "Select new" only has work to do when an unselected row on this page
	// hasn't been exported in the current format yet.
	const selectNewBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'select-new');
	const label = formatLabel(STATE.format);
	selectNewBtn.disabled =
		STATE.busy || !visibleIds.some((id) => id && !STATE.selected.has(id) && exportedAt(id, STATE.format) === null);
	selectNewBtn.title = t('selectNewTitle', label);
	toolbarPart(STATE.toolbar, 'history-import').textContent = t('historyImport', label);
	toolbarPart<HTMLButtonElement>(STATE.toolbar, 'history-forget').disabled = exportedTotal() === 0;

	// Trimming changes the files, so while it applies a chip says so on the
	// toolbar itself, not just inside the "⋯" menu.
	const trim = effectiveTrim();
	toolbarPart(STATE.toolbar, 'trim-chip').hidden = trim === 0;
	toolbarPart(STATE.toolbar, 'trim-chip-text').textContent = trim > 0 ? t('trimChip', radiusLabel(trim)) : '';
	const trimSelect = toolbarPart<HTMLSelectElement>(STATE.toolbar, 'trim');
	trimSelect.disabled = STATE.format !== 'gpx';
	if (trimSelect.disabled) {
		trimSelect.setAttribute('title', t('trimOnlyGpx'));
	} else {
		trimSelect.removeAttribute('title');
	}
	// GPX and TCX can be merged; Original files (mostly binary FIT) can't.
	// Rather than hide the button in Original mode (which leaves users
	// wondering where it went after switching format), keep it visible but
	// disabled, with a tooltip explaining the constraint. Easier to learn.
	// The label and tooltip say what the merge will produce.
	//
	// Use setAttribute/removeAttribute explicitly - setting `.title = ''` is
	// inconsistent across Chromium versions about whether the empty `title`
	// attribute lingers in the DOM, which trips up attribute-based assertions
	// in the e2e suite.
	const mergeAvailable = STATE.format !== 'original';
	mergeBtn.disabled = !mergeAvailable || total === 0 || STATE.busy;
	const joining = STATE.format === 'gpx' && STATE.mergeMode === 'single';
	const mergeLabel = STATE.format === 'tcx' ? t('mergeSelectedTcx') : joining ? t('joinSelected') : t('mergeSelected');
	if (mergeBtn.textContent !== mergeLabel) mergeBtn.textContent = mergeLabel;
	const mergeTitle = !mergeAvailable
		? t('mergeNotOriginal')
		: STATE.format === 'tcx'
			? t('mergeTcxTitle')
			: joining
				? t('joinTitle')
				: null;
	if (mergeTitle) {
		mergeBtn.setAttribute('title', mergeTitle);
	} else {
		mergeBtn.removeAttribute('title');
	}

	const allCb = STATE.toolbar.querySelector<HTMLInputElement>('.sbgx-select-all-cb')!;
	if (visibleIds.length === 0) {
		allCb.checked = false;
		allCb.indeterminate = false;
	} else {
		allCb.checked = visibleSelected === visibleIds.length;
		allCb.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
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
	const container = toolbarPart(STATE.toolbar, 'status');
	toolbarPart(container, 'status-text').textContent = text;
	container.dataset.kind = kind;
	toolbarPart(container, 'spinner').hidden = !spinner;
}

/**
 * Show STATE.lastRun's failures under the toolbar: one line per activity,
 * linking to it, with the reason - so a partial run says exactly what's
 * missing, not just the first error. Hidden when there's nothing to show.
 */
function renderFailures(): void {
	if (!STATE.toolbar) return;
	const run = STATE.lastRun;
	toolbarPart(STATE.toolbar, 'failures').hidden = !run;
	if (!run) return;

	const retryBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'retry');
	retryBtn.hidden = run.retryFormat === null;
	retryBtn.disabled = STATE.busy;
	retryBtn.textContent = t('retryFailed', String(run.failed.length));

	const items = run.failed.map(({ activity, reason }) => {
		const link = document.createElement('a');
		link.href = `/activities/${activity.id}`;
		link.target = '_blank';
		link.rel = 'noopener';
		link.textContent = activity.name;
		const li = document.createElement('li');
		li.append(link, ` - ${reason}`);
		return li;
	});
	toolbarPart(STATE.toolbar, 'failures-list').replaceChildren(...items);
}

/** Show `badge` (the ✓ beside a row button) if `id` was exported in the current format. */
function renderExportBadge(badge: HTMLElement, id: string): void {
	const at = exportedAt(id, STATE.format);
	badge.hidden = at === null;
	badge.title = at === null ? '' : t('exportedOn', [formatLabel(STATE.format), new Date(at).toLocaleDateString()]);
}

/** Re-evaluate every row's ✓ - after a format change or a history update. */
function renderExportBadges(): void {
	for (const badge of document.querySelectorAll<HTMLElement>('.sbgx-done')) {
		const id = badge.closest<HTMLTableRowElement>('tr')?.dataset.sbgxId;
		if (id) renderExportBadge(badge, id);
	}
}

/** Record successfully exported activities (best-effort) and refresh the ✓ marks. */
function rememberExports(ids: string[], format: ExportFormat): void {
	recordExports(ids, format)
		.then(() => {
			renderExportBadges();
			renderToolbarCounts();
		})
		.catch((err: unknown) => {
			console.warn('Could not save export history', err);
		});
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
 * (e.g. "Saved 4 activities.") and failure list so the toolbar reflects only
 * the current intent, but leaves in-progress download messages alone.
 */
function onSelectionChanged(): void {
	syncRowCheckboxes();
	if (!STATE.busy) {
		setStatus('');
		STATE.lastRun = null;
		renderFailures();
	}
	renderToolbarCounts();
}

/** Everything selected, on this page or others, in the order it was picked. */
function collectSelectedActivities(): ActivityRow[] {
	return [...STATE.selected.values()];
}

/** Map a downloader progress event onto the status line. */
function showProgress(ev: ProgressEvent, format: ExportFormat): void {
	if (ev.stage === 'downloading') {
		setStatus(t('downloadingProgress', [String(ev.completed), String(ev.total)]), 'info', { spinner: true });
	} else if (ev.stage === 'throttled') {
		setStatus(t('rateLimited', String(ev.seconds)), 'info', { spinner: true });
	} else if (ev.stage === 'zipping') {
		setStatus(t('buildingZip'), 'info', { spinner: true });
	} else {
		setStatus(format === 'tcx' ? t('mergingTcx') : t('mergingGpx'), 'info', { spinner: true });
	}
}

/**
 * Shared lifecycle for zip and merge runs: single-flighting via STATE.busy,
 * the Cancel button, progress, and the terminal outcome - success, partial
 * success (with the failure list), cancelled, or failed.
 */
async function runExport(activities: ActivityRow[], format: ExportFormat, mode: 'zip' | 'merge'): Promise<void> {
	if (STATE.busy || activities.length === 0) return;

	const controller = new AbortController();
	STATE.busy = true;
	STATE.abort = controller;
	STATE.lastRun = null;
	renderToolbarCounts();
	renderFailures();
	setStatus(t('preparingDownloads', String(activities.length)), 'info', { spinner: true });
	const options: BulkOptions = {
		onProgress: (ev) => showProgress(ev, format),
		signal: controller.signal,
		names: STATE.names,
		trimRadius: effectiveTrim(),
	};
	const mergeMode = STATE.mergeMode;
	try {
		const result =
			mode === 'merge'
				? await downloadMerged(activities, format === 'tcx' ? 'tcx' : 'gpx', mergeMode, options)
				: await downloadBulk(activities, format, options);
		// Trimmed files aren't backups of the activities, so they don't count.
		if (mode === 'zip' && !options.trimRadius) {
			const failedIds = new Set(result.failed.map((f) => f.id));
			rememberExports(
				activities.filter((a) => !failedIds.has(a.id)).map((a) => a.id),
				format,
			);
		}
		const firstFailed = result.failed[0];
		if (firstFailed) {
			setStatus(t('savedWithSkips', [String(result.ok), String(result.failed.length), firstFailed.reason]), 'warn');
			const byId = new Map(activities.map((a) => [a.id, a]));
			STATE.lastRun = {
				failed: result.failed.map((f) => ({ activity: byId.get(f.id)!, reason: f.reason })),
				retryFormat: mode === 'zip' ? format : null,
			};
		} else {
			setStatus(savedMessage(mode, format, mergeMode, result.ok), 'ok');
		}
	} catch (err) {
		if (controller.signal.aborted) {
			setStatus(t('cancelled'), 'warn');
		} else {
			const message = err instanceof Error ? err.message : String(err);
			setStatus(t('downloadFailed', message), 'err');
		}
	} finally {
		STATE.busy = false;
		STATE.abort = null;
		renderToolbarCounts();
		renderFailures();
	}
}

/** The success message for a fully successful run of `count` activities. */
function savedMessage(mode: 'zip' | 'merge', format: ExportFormat, mergeMode: MergeMode, count: number): string {
	if (mode === 'zip') return t('savedActivities', String(count));
	if (format === 'tcx') return t('savedMergedTcx', String(count));
	return mergeMode === 'single' ? t('savedJoined', String(count)) : t('savedMerged', String(count));
}

function handleBulkClick(): Promise<void> {
	return runExport(collectSelectedActivities(), STATE.format, 'zip');
}

/**
 * Merge-mode bulk handler. Same fetch pool as {@link handleBulkClick} but
 * emits a single combined GPX or TCX instead of a zip of per-activity files.
 * Not possible for Original; the button is disabled then, but we still gate
 * defensively in case the user clicked between format changes.
 */
function handleMergeClick(): Promise<void> {
	if (STATE.format === 'original') return Promise.resolve();
	return runExport(collectSelectedActivities(), STATE.format, 'merge');
}

/** Re-run a zip run's failures only, in the format that run used. */
function handleRetryClick(): Promise<void> {
	const run = STATE.lastRun;
	if (!run?.retryFormat) return Promise.resolve();
	return runExport(
		run.failed.map((f) => f.activity),
		run.retryFormat,
		'zip',
	);
}

/** List-only export: the selected rows' table columns as CSV, no file fetches. */
function handleCsvClick(): void {
	if (STATE.busy) return;
	const activities = collectSelectedActivities();
	if (activities.length === 0) return;
	downloadActivitiesCsv(activities);
	setStatus(t('savedCsv', String(activities.length)), 'ok');
	// A previous run's failure list no longer describes what just happened.
	STATE.lastRun = null;
	renderFailures();
}

// ---------- Boot + observer ----------

function tick(): void {
	const table = findActivitiesTable();
	if (!table) return;
	ensureToolbar(table);
	injectHeader(table);
	injectAllRows(table);
	renderToolbarCounts();
}

async function start(): Promise<void> {
	// Load saved preferences and the export history first so the toolbar and
	// row buttons render with them from the start instead of flashing the
	// defaults.
	await Promise.all([
		loadPreferences(),
		loadHistory(() => {
			renderExportBadges();
			renderToolbarCounts();
		}),
	]);
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
	document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
	void start();
}
