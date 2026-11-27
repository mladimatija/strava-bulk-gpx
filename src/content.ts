// Content script entry. Runs on https://www.strava.com/athlete/training* in
// the page's isolated world but with same-origin fetch capability - that's the
// magic that lets us call /activities/:id/export_gpx without any cookie wrangling.
//
// Strategy:
//   - Find the activities table (whatever React happens to have rendered).
//   - Mount a toolbar above it once.
//   - For each visible row, inject a checkbox at the start and a "GPX" button
//     at the end - but only when the row can be exported in the current
//     format: GPX and TCX need GPS data (distance > 0), Original doesn't.
//   - A MutationObserver re-runs the injection whenever Strava replaces the
//     table body (pagination, search, sort). Selection state survives via a
//     module-scope Map keyed by activity id, so a selection can span pages -
//     and selection.ts saves it, so it survives a reload too.

import {
	downloadSingle,
	downloadBulk,
	downloadMerged,
	downloadToFolder,
	downloadActivitiesCsv,
	type BulkOptions,
} from './downloader.ts';
import { activityIdsFromCsv } from './csv.ts';
import { directoryPicker } from './folder.ts';
import { clearHistory, exportedAt, exportedTotal, loadHistory, recordExports } from './history.ts';
import { t, type MessageKey } from './i18n.ts';
import { firstRowHref, pagerButton, pagerText, turnPage } from './paging.ts';
import { forgetSavedSelection, loadSelection, saveSelection } from './selection.ts';
import {
	effectiveTrim,
	FORMAT_STORAGE_KEY,
	formatLabel,
	loadPreferences,
	MERGE_MODE_STORAGE_KEY,
	NAMES_STORAGE_KEY,
	parseFormat,
	parseMergeMode,
	parseNames,
	parseSplit,
	parseTrim,
	radiusLabel,
	savePreference,
	SPLIT_STORAGE_KEY,
	STATE,
} from './state.ts';
import { activityFromRow, findActivitiesTable, learnDateOrder, rowSelectable, visibleSelectableRows } from './table.ts';
import { toolbarHtml } from './toolbar-html.ts';
import type { ActivityRow, BulkResult, ExportFormat, MergeMode, ProgressEvent, StatusKind } from './types.ts';
import { lengthLabel, METRES_PER_FOOT, type LengthUnit } from './units.ts';

// ---------- Selection ----------

/**
 * Save the selection for the next page load (see selection.ts) - except
 * while Select all pages runs, which would otherwise rewrite the whole,
 * growing selection on every page; it saves once when it's done.
 */
function persistSelection(): void {
	if (STATE.selectingPages) return;
	saveSelection(() => [...STATE.selected.values()]);
}

function setSelected(activity: ActivityRow, selected: boolean): void {
	if (selected) STATE.selected.set(activity.id, activity);
	else STATE.selected.delete(activity.id);
	persistSelection();
}

/**
 * Select the selectable rows on this page - with `onlyNew`, just those not
 * yet exported in the current format. Off-page picks stay as they are.
 */
function selectVisible(onlyNew: boolean): void {
	for (const row of visibleSelectableRows()) {
		const id = row.dataset.sbgxId;
		if (!id || (onlyNew && exportedAt(id, STATE.format) !== null)) continue;
		const a = activityFromRow(row);
		if (a) setSelected(a, true);
	}
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
	row.dataset.sbgxHasGps = a.hasGps ? '1' : '0';

	// Both cells always exist, to keep column alignment; what's in them
	// depends on the format (see renderRowControls).
	const cbCell = document.createElement('td');
	cbCell.className = 'sbgx-cell sbgx-cell-check';
	row.insertBefore(cbCell, row.firstChild);
	const dlCell = document.createElement('td');
	dlCell.className = 'sbgx-cell sbgx-cell-dl';
	row.appendChild(dlCell);
	renderRowControls(row);
}

/**
 * Give a row its checkbox, ✓ and export button when it can be exported in
 * the current format, or take them away when it can't - an indoor activity
 * has controls in Original mode only.
 */
function renderRowControls(row: HTMLTableRowElement): void {
	const cbCell = row.querySelector<HTMLTableCellElement>(':scope > .sbgx-cell-check');
	const dlCell = row.querySelector<HTMLTableCellElement>(':scope > .sbgx-cell-dl');
	const id = row.dataset.sbgxId;
	if (!cbCell || !dlCell || !id) return;
	if (!rowSelectable(row)) {
		cbCell.replaceChildren();
		dlCell.replaceChildren();
		return;
	}
	if (cbCell.childElementCount > 0) return;

	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.className = 'sbgx-row-cb';
	cb.checked = STATE.selected.has(id);
	// `click` rather than `change`: only the click event carries shiftKey.
	// Keyboard toggles (Space) dispatch a click too.
	cb.addEventListener('click', (e: MouseEvent) => {
		const a = activityFromRow(row);
		if (!a) return;
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

	const done = document.createElement('span');
	done.className = 'sbgx-done';
	done.textContent = '✓';
	renderExportBadge(done, id);
	dlCell.appendChild(done);

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'sbgx-btn sbgx-btn-primary sbgx-btn-row';
	btn.textContent = formatLabel(STATE.format);
	btn.title = t('rowButtonTitle', formatLabel(STATE.format));
	btn.addEventListener('click', async (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const a = activityFromRow(row);
		if (btn.disabled || !a) return;
		btn.disabled = true;
		const old = btn.textContent ?? formatLabel(STATE.format);
		btn.textContent = '…';
		// Read the format from STATE at click time so changing the
		// selector after rendering immediately affects what gets fetched.
		const format = STATE.format;
		const trim = effectiveTrim();
		// Whether this click put a "Strava is limiting requests" wait on the
		// status line, to take it off again afterwards.
		let waited = false;
		btn.title = t('rowButtonTitle', formatLabel(format));
		try {
			await downloadSingle(a, format, STATE.names, trim, (ev) => {
				if (STATE.busy || ev.stage !== 'throttled') return;
				waited = true;
				showProgress(ev, '');
			});
			// A trimmed file isn't a backup of the activity.
			if (trim === 0) rememberExports([a.id], format);
			if (waited && !STATE.busy) setStatus('');
		} catch (err) {
			// On the status line rather than in a blocking alert(); the
			// button's tooltip keeps the reason while a bulk run owns the
			// status line.
			const message = t('rowDownloadFailed', [a.id, err instanceof Error ? err.message : String(err)]);
			btn.title = message;
			if (!STATE.busy) setStatus(message, 'err');
		} finally {
			btn.disabled = false;
			btn.textContent = old;
		}
	});
	dlCell.appendChild(btn);
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
	toolbar.innerHTML = toolbarHtml();

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
		selectVisible(true);
		onSelectionChanged();
	});
	toolbarPart(toolbar, 'select-pages').addEventListener('click', () => void handleSelectPages(false));
	toolbarPart(toolbar, 'select-new-pages').addEventListener('click', () => void handleSelectPages(true));

	toolbarPart(toolbar, 'bulk').addEventListener('click', handleBulkClick);
	toolbarPart(toolbar, 'merge').addEventListener('click', handleMergeClick);
	toolbarPart(toolbar, 'csv').addEventListener('click', handleCsvClick);
	toolbarPart(toolbar, 'folder').addEventListener('click', () => void handleFolderClick());
	toolbarPart(toolbar, 'cancel').addEventListener('click', () => STATE.abort?.abort());
	toolbarPart(toolbar, 'save-part').addEventListener('click', () => STATE.pendingPart?.save());
	toolbarPart(toolbar, 'retry').addEventListener('click', handleRetryClick);
	toolbarPart(toolbar, 'clear').addEventListener('click', () => {
		STATE.selected.clear();
		STATE.anchorId = null;
		persistSelection();
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
		dropUnexportable();
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
 * merges combine activities; hiding the start/end of GPX and TCX tracks
 * (whose chip sits on the toolbar, so it can't go unnoticed); when to split
 * large zips; and export history -
 * marking activities from an earlier CSV as exported (so existing users
 * don't start with everything "new"), and forgetting the history.
 */
function wireMoreMenu(toolbar: HTMLDivElement): void {
	const more = toolbarPart<HTMLDetailsElement>(toolbar, 'more');
	document.addEventListener('click', (e) => {
		if (more.open && !more.contains(e.target as Node)) more.open = false;
	});
	// The menu opens leftwards, unless the toolbar has wrapped the "⋯" too
	// close to the left edge for it to fit.
	const menu = more.querySelector<HTMLElement>('.sbgx-menu')!;
	more.addEventListener('toggle', () => {
		if (more.open) menu.classList.toggle('sbgx-menu-right', more.getBoundingClientRect().right < menu.offsetWidth);
	});

	const mergeModeSelect = toolbarPart<HTMLSelectElement>(toolbar, 'merge-mode');
	mergeModeSelect.value = STATE.mergeMode;
	mergeModeSelect.addEventListener('change', () => {
		STATE.mergeMode = parseMergeMode(mergeModeSelect.value);
		savePreference(MERGE_MODE_STORAGE_KEY, STATE.mergeMode);
		renderToolbarCounts();
	});

	const splitSelect = toolbarPart<HTMLSelectElement>(toolbar, 'split');
	splitSelect.value = String(STATE.splitMb);
	splitSelect.addEventListener('change', () => {
		STATE.splitMb = parseSplit(splitSelect.value);
		savePreference(SPLIT_STORAGE_KEY, String(STATE.splitMb));
	});

	const trimSelect = toolbarPart<HTMLSelectElement>(toolbar, 'trim');
	const custom = toolbarPart(toolbar, 'trim-custom');
	const customValue = toolbarPart<HTMLInputElement>(toolbar, 'trim-value');
	const customUnit = toolbarPart<HTMLSelectElement>(toolbar, 'trim-unit');
	trimSelect.value = STATE.trimMenu.choice;
	customValue.value = STATE.trimMenu.customValue;
	customUnit.value = STATE.trimMenu.unit;
	custom.hidden = STATE.trimMenu.choice !== 'custom';
	// Apply whichever radius the menu shows. A custom distance is the
	// number as typed, in the unit picked - switching the unit doesn't
	// convert the number, it changes what it means. No valid number = off.
	const applyTrim = (): void => {
		custom.hidden = trimSelect.value !== 'custom';
		STATE.trimMenu = {
			choice: custom.hidden ? String(parseTrim(trimSelect.value)) : 'custom',
			customValue: customValue.value,
			unit: customUnit.value === 'ft' ? 'ft' : 'm',
		};
		if (custom.hidden) {
			STATE.trim = parseTrim(trimSelect.value);
			STATE.trimLabel = radiusLabel(STATE.trim);
		} else {
			const value = customValue.valueAsNumber;
			const unit: LengthUnit = customUnit.value === 'ft' ? 'ft' : 'm';
			const valid = Number.isFinite(value) && value > 0;
			STATE.trim = valid ? value * (unit === 'ft' ? METRES_PER_FOOT : 1) : 0;
			STATE.trimLabel = valid ? lengthLabel(value, unit, navigator.language) : '';
		}
		renderToolbarCounts();
	};
	trimSelect.addEventListener('change', () => {
		applyTrim();
		if (!custom.hidden) customValue.focus();
	});
	customValue.addEventListener('input', applyTrim);
	customUnit.addEventListener('change', applyTrim);
	toolbarPart(toolbar, 'trim-off').addEventListener('click', () => {
		trimSelect.value = '0';
		applyTrim();
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
 * Bring every row's controls in line with the currently selected format:
 * indoor rows gain or lose theirs (see renderRowControls), and every per-row
 * button's text + title names the format. The click handlers themselves
 * already read STATE.format at click time.
 */
function refreshRowButtons(): void {
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbgx-id]')) renderRowControls(row);
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
	const savePart = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'save-part');
	savePart.hidden = !STATE.pendingPart;
	savePart.textContent = STATE.pendingPart ? t('savePart', String(STATE.pendingPart.n)) : '';

	// "Select new" only has work to do when an unselected row on this page
	// hasn't been exported in the current format yet.
	const selectNewBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'select-new');
	const label = formatLabel(STATE.format);
	selectNewBtn.disabled =
		STATE.busy || !visibleIds.some((id) => id && !STATE.selected.has(id) && exportedAt(id, STATE.format) === null);
	selectNewBtn.title = t('selectNewTitle', label);
	toolbarPart<HTMLButtonElement>(STATE.toolbar, 'select-pages').disabled = STATE.busy;
	const selectNewPagesBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'select-new-pages');
	selectNewPagesBtn.disabled = STATE.busy;
	selectNewPagesBtn.title = t('selectNewAllPagesTitle', label);
	// Saving to a folder needs Chromium's folder picker; without it the
	// menu doesn't offer it.
	const folderBtn = toolbarPart<HTMLButtonElement>(STATE.toolbar, 'folder');
	folderBtn.hidden = directoryPicker() === null;
	folderBtn.disabled = total === 0 || STATE.busy;
	toolbarPart(STATE.toolbar, 'folder-heading').hidden = folderBtn.hidden;
	toolbarPart(STATE.toolbar, 'history-import').textContent = t('historyImport', label);
	toolbarPart<HTMLButtonElement>(STATE.toolbar, 'history-forget').disabled = exportedTotal() === 0;

	// Trimming changes the files, so while it applies a chip says so on the
	// toolbar itself, not just inside the "⋯" menu.
	const trim = effectiveTrim();
	toolbarPart(STATE.toolbar, 'trim-chip').hidden = trim === 0;
	toolbarPart(STATE.toolbar, 'trim-chip-text').textContent = trim > 0 ? t('trimChip', STATE.trimLabel) : '';
	const trimSelect = toolbarPart<HTMLSelectElement>(STATE.toolbar, 'trim');
	trimSelect.disabled = STATE.format === 'original';
	toolbarPart<HTMLInputElement>(STATE.toolbar, 'trim-value').disabled = trimSelect.disabled;
	toolbarPart<HTMLSelectElement>(STATE.toolbar, 'trim-unit').disabled = trimSelect.disabled;
	if (trimSelect.disabled) {
		trimSelect.setAttribute('title', t('trimNotOriginal'));
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
	const kind = mergeKind(STATE.format, STATE.mergeMode);
	const mergeLabel = t(MERGE_TEXT[kind].button);
	if (mergeBtn.textContent !== mergeLabel) mergeBtn.textContent = mergeLabel;
	const titleKey = MERGE_TEXT[kind].title;
	const mergeTitle = !mergeAvailable ? t('mergeNotOriginal') : titleKey ? t(titleKey) : null;
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

/**
 * After switching to GPX or TCX, drop selected activities without GPS -
 * Strava has no such export for them - and say so, rather than letting the
 * next download fail on each of them.
 */
function dropUnexportable(): void {
	if (STATE.format === 'original') return;
	const dropped = [...STATE.selected.values()].filter((a) => !a.hasGps);
	if (dropped.length === 0) return;
	for (const a of dropped) setSelected(a, false);
	syncRowCheckboxes();
	if (!STATE.busy) setStatus(t('noGpsDeselected', [String(dropped.length), formatLabel(STATE.format)]), 'warn');
}

/** Everything selected, on this page or others, in the order it was picked. */
function collectSelectedActivities(): ActivityRow[] {
	return [...STATE.selected.values()];
}

/** What a merge produces: a TCX, or - from GPX - a track collection, one joined activity or GeoJSON. */
type MergeKind = 'tcx' | 'tracks' | 'single' | 'geojson';

function mergeKind(format: ExportFormat, mergeMode: MergeMode): MergeKind {
	return format === 'tcx' ? 'tcx' : mergeMode;
}

/** The merge button's label and tooltip, and the status texts of a merge, by what it produces. */
const MERGE_TEXT: Record<
	MergeKind,
	{ button: MessageKey; title: MessageKey | null; merging: MessageKey; saved: MessageKey }
> = {
	tcx: { button: 'mergeSelectedTcx', title: 'mergeTcxTitle', merging: 'mergingTcx', saved: 'savedMergedTcx' },
	tracks: { button: 'mergeSelected', title: null, merging: 'mergingGpx', saved: 'savedMerged' },
	single: { button: 'joinSelected', title: 'joinTitle', merging: 'mergingGpx', saved: 'savedJoined' },
	geojson: {
		button: 'mergeSelectedGeojson',
		title: 'mergeGeojsonTitle',
		merging: 'mergingGeojson',
		saved: 'savedGeojson',
	},
};

/** Map a downloader progress event onto the status line; `merging` is the text of a merge's last stage. */
function showProgress(ev: ProgressEvent, merging: string): void {
	if (ev.stage === 'downloading') {
		setStatus(t('downloadingProgress', [String(ev.completed), String(ev.total)]), 'info', { spinner: true });
	} else if (ev.stage === 'throttled') {
		setStatus(t('rateLimited', String(ev.seconds)), 'info', { spinner: true });
	} else if (ev.stage === 'zipping') {
		setStatus(t('buildingZip'), 'info', { spinner: true });
	} else {
		setStatus(merging, 'info', { spinner: true });
	}
}

/**
 * Show "Save part N" and resolve when it's clicked: Chrome lets a page start
 * one download without a click and holds back or blocks the rest, so every
 * zip part after the first is saved from a click of its own (see
 * BulkOptions.confirmPart). Rejects if the run is cancelled meanwhile.
 */
function waitForPartClick(n: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (): void => {
			STATE.pendingPart = null;
			signal.removeEventListener('abort', onAbort);
			renderToolbarCounts();
		};
		const onAbort = (): void => {
			finish();
			reject(signal.reason instanceof Error ? signal.reason : new Error(t('cancelled')));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		STATE.pendingPart = {
			n,
			save: () => {
				finish();
				resolve();
			},
		};
		setStatus(t('partReady', String(n)), 'info');
		renderToolbarCounts();
	});
}

/** How a run saves what it fetches: as zips, as one merged file, or into a folder. */
type RunMode = 'zip' | 'merge' | 'folder';

/**
 * Shared lifecycle for zip, merge and folder runs: single-flighting via
 * STATE.busy, the Cancel button, progress, and the terminal outcome -
 * success, partial success (with the failure list), cancelled, or failed.
 * `dir` is the folder a folder run writes to.
 */
async function runExport(
	activities: ActivityRow[],
	format: ExportFormat,
	mode: RunMode,
	dir: FileSystemDirectoryHandle | null = null,
): Promise<void> {
	if (STATE.busy || activities.length === 0) return;

	const controller = new AbortController();
	STATE.busy = true;
	STATE.abort = controller;
	STATE.lastRun = null;
	renderToolbarCounts();
	renderFailures();
	setStatus(t('preparingDownloads', String(activities.length)), 'info', { spinner: true });
	// What's already saved when a run is cancelled stays saved: zip parts,
	// or the files written to a folder.
	let savedParts = 0;
	let savedFiles = 0;
	const trimRadius = format === 'original' ? 0 : STATE.trim;
	const mergeMode = STATE.mergeMode;
	const kind = mergeKind(format, mergeMode);
	const options: BulkOptions = {
		onProgress: (ev) => showProgress(ev, t(MERGE_TEXT[kind].merging)),
		signal: controller.signal,
		names: STATE.names,
		trimRadius,
		splitBytes: STATE.splitMb * 1_000_000,
		onSaved: (ids) => {
			savedParts++;
			savedFiles += ids.length;
			// Trimmed files aren't backups of the activities, so they don't count.
			if (trimRadius === 0) rememberExports(ids, format);
		},
		confirmPart: (n) => waitForPartClick(n, controller.signal),
	};
	try {
		let result: BulkResult;
		if (mode === 'merge') {
			result = await downloadMerged(activities, format === 'tcx' ? 'tcx' : 'gpx', mergeMode, options);
		} else if (mode === 'folder' && dir) {
			result = await downloadToFolder(activities, format, dir, options);
		} else {
			result = await downloadBulk(activities, format, options);
		}
		const firstFailed = result.failed[0];
		if (firstFailed) {
			setStatus(t('savedWithSkips', [String(result.ok), String(result.failed.length), firstFailed.reason]), 'warn');
			const byId = new Map(activities.map((a) => [a.id, a]));
			STATE.lastRun = {
				failed: result.failed.map((f) => ({ activity: byId.get(f.id)!, reason: f.reason })),
				retryFormat: mode === 'merge' ? null : format,
				retryDir: mode === 'folder' ? dir : null,
			};
		} else {
			setStatus(savedMessage(mode, kind, result), 'ok');
			// Fully exported: a reload shouldn't bring this batch back into
			// the next backup. It stays selected on screen.
			if (mode !== 'merge') forgetSavedSelection();
		}
	} catch (err) {
		if (controller.signal.aborted) {
			setStatus(cancelledMessage(mode, savedParts, savedFiles), 'warn');
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

/** The success message for a fully successful run. */
function savedMessage(mode: RunMode, kind: MergeKind, result: BulkResult): string {
	const count = String(result.ok);
	if (mode === 'folder') return t('savedToFolder', count);
	if (mode === 'merge') return t(MERGE_TEXT[kind].saved, count);
	return result.parts > 1 ? t('savedActivitiesParts', [count, String(result.parts)]) : t('savedActivities', count);
}

/** What a cancelled run reports: what it had already saved, if anything. */
function cancelledMessage(mode: RunMode, savedParts: number, savedFiles: number): string {
	if (mode === 'folder') return savedFiles > 0 ? t('cancelledFolder', String(savedFiles)) : t('cancelled');
	return savedParts > 0 ? t('cancelledAfterParts', String(savedParts)) : t('cancelled');
}

function handleBulkClick(): Promise<void> {
	return runExport(collectSelectedActivities(), STATE.format, 'zip');
}

/**
 * Merge-mode bulk handler. Same fetch pool as {@link handleBulkClick} but
 * emits a single combined file instead of a zip of per-activity files.
 * Not possible for Original; the button is disabled then, but we still gate
 * defensively in case the user clicked between format changes.
 */
function handleMergeClick(): Promise<void> {
	if (STATE.format === 'original') return Promise.resolve();
	return runExport(collectSelectedActivities(), STATE.format, 'merge');
}

/**
 * "Save selected to a folder…": ask for a folder, then write every selected
 * activity's file straight into it (see downloadToFolder). The picker has to
 * open from the click itself, so nothing is awaited before it. Dismissing
 * it is not an error.
 */
async function handleFolderClick(): Promise<void> {
	const pick = directoryPicker();
	const activities = collectSelectedActivities();
	if (!pick || STATE.busy || activities.length === 0 || !STATE.toolbar) return;
	toolbarPart<HTMLDetailsElement>(STATE.toolbar, 'more').open = false;
	let dir: FileSystemDirectoryHandle;
	try {
		dir = await pick({ id: 'strava-export', mode: 'readwrite' });
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') return;
		setStatus(t('downloadFailed', err instanceof Error ? err.message : String(err)), 'err');
		return;
	}
	await runExport(activities, STATE.format, 'folder', dir);
}

/** Re-run a zip or folder run's failures only, in the format that run used. */
function handleRetryClick(): Promise<void> {
	const run = STATE.lastRun;
	if (!run?.retryFormat) return Promise.resolve();
	return runExport(
		run.failed.map((f) => f.activity),
		run.retryFormat,
		run.retryDir ? 'folder' : 'zip',
		run.retryDir,
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

// ---------- Selecting across pages ----------

/**
 * "Select all pages" / "Select new on all pages": page through Strava's list
 * with its own pager - back to the first page, then forward to the last -
 * selecting on every page. It works on whatever the list shows, so Strava's
 * search and filters scope it. Only Strava's own pages load; no activity
 * files are fetched until the user downloads. Cancel keeps what was
 * selected so far.
 */
async function handleSelectPages(onlyNew: boolean): Promise<void> {
	if (STATE.busy) return;
	const controller = new AbortController();
	STATE.busy = true;
	STATE.abort = controller;
	STATE.lastRun = null;
	STATE.selectingPages = true;
	renderFailures();
	renderToolbarCounts();
	const before = STATE.selected.size;
	const pages = new Set<string>();
	const selectThisPage = (): void => {
		selectVisible(onlyNew);
		pages.add(firstRowHref() ?? '');
		syncRowCheckboxes();
		renderToolbarCounts();
		setStatus(t('selectingPages', [pagerText() || String(pages.size), String(STATE.selected.size)]), 'info', {
			spinner: true,
		});
	};
	try {
		selectThisPage();
		for (let back = pagerButton('previous_page'); back; back = pagerButton('previous_page')) {
			await turnPage(back, controller.signal);
			// Augment the new rows now rather than on the observer's next frame.
			tick();
			selectThisPage();
		}
		for (let next = pagerButton('next_page'); next; next = pagerButton('next_page')) {
			await turnPage(next, controller.signal);
			tick();
			selectThisPage();
		}
		setStatus(t('selectedPages', [String(STATE.selected.size - before), String(pages.size)]), 'ok');
	} catch (err) {
		if (controller.signal.aborted) {
			setStatus(t('selectPagesStopped', String(STATE.selected.size - before)), 'warn');
		} else {
			const message = err instanceof Error ? err.message : String(err);
			setStatus(t('downloadFailed', message), 'err');
		}
	} finally {
		STATE.busy = false;
		STATE.abort = null;
		STATE.selectingPages = false;
		persistSelection();
		renderToolbarCounts();
	}
}

// ---------- Boot + observer ----------

function tick(): void {
	const table = findActivitiesTable();
	if (!table) return;
	ensureToolbar(table);
	injectHeader(table);
	learnDateOrder(table);
	injectAllRows(table);
	renderToolbarCounts();
}

async function start(): Promise<void> {
	// Load saved preferences, the export history and the selection first so
	// the toolbar and row buttons render with them from the start instead of
	// flashing the defaults.
	const [, , saved] = await Promise.all([
		loadPreferences(),
		loadHistory(() => {
			renderExportBadges();
			renderToolbarCounts();
		}),
		loadSelection(),
	]);
	// Activities without GPS were only selectable in Original mode; if the
	// format has changed since (in another tab, say), they can't be exported.
	for (const a of saved) if (a.hasGps || STATE.format === 'original') STATE.selected.set(a.id, a);
	tick();
	// Strava's React reflows the table on every search / sort / pagination.
	// A single observer on the body handles all of it; the injection helpers
	// are idempotent. One re-render is a burst of mutations, so they're
	// coalesced into a single tick on the next frame; and our own toolbar
	// updates (the status line changes with every file of a download) are
	// none of Strava's doing and don't need one at all.
	let scheduled = false;
	const obs = new MutationObserver((records) => {
		if (scheduled) return;
		const toolbar = STATE.toolbar;
		if (toolbar && records.every((r) => toolbar.contains(r.target))) return;
		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			tick();
		});
	});
	obs.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
	void start();
}
