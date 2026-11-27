// Reading Strava's My Activities table: finding it, and turning a rendered
// row into the activity it shows. Nothing here changes the page.

import { dateOrderOf, isoDate } from './dates.ts';
import { distanceShown } from './distance.ts';
import { STATE } from './state.ts';
import type { ActivityColumn, ActivityRow } from './types.ts';

/** Find the activities table by looking for any table that links to /activities/N. */
export function findActivitiesTable(): HTMLTableElement | null {
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
export function rowColumns(row: HTMLTableRowElement): ActivityColumn[] {
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

/** A date as Strava's Date column shows it: "17/11/2026", "2026/11/17", "17.11.2026", … */
const DATE_TEXT = /\d{1,4}\s?[./\-年]\s?\d{1,2}\s?[./\-月]\s?\d{1,4}/;

/** The locale Strava renders the page in, for weekday names in dates. */
export function pageLocale(): string {
	return document.documentElement.lang || navigator.language;
}

/** Text of the row's Date cell: Strava's `col-date` cell, else the first cell that reads as a date. */
export function dateText(row: HTMLTableRowElement): string | null {
	const cells = Array.from(row.cells).filter((td) => !td.classList.contains('sbgx-cell'));
	const cell =
		cells.find((td) => td.classList.contains('col-date')) ?? cells.find((td) => DATE_TEXT.test(td.textContent ?? ''));
	return cell ? (cell.textContent ?? '').trim() : null;
}

/** Learn the table's day/month order from the first row whose date settles it. */
export function learnDateOrder(table: HTMLTableElement): void {
	if (STATE.dateOrder) return;
	for (const row of Array.from(table.tBodies[0]?.rows ?? [])) {
		const text = dateText(row);
		const order = text && dateOrderOf(text, pageLocale());
		if (order) {
			STATE.dateOrder = order;
			return;
		}
	}
}

/** Pull { id, name, sport_type, date, hasGps, columns } from a rendered table row, or null. */
export function activityFromRow(row: HTMLTableRowElement): ActivityRow | null {
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
	const text = dateText(row);
	const date = text ? isoDate(text, pageLocale(), STATE.dateOrder) : null;
	return { id, name, sport_type, date, hasGps: rowHasGps(row), columns: rowColumns(row) };
}

/**
 * Heuristic: an activity has GPS if its Distance cell shows a positive
 * value. Indoor or manually-entered workouts (Weight Training, Workout, etc.)
 * show "0 km".
 *
 * The cell is Strava's `col-dist` when the table has one; otherwise the
 * first cell that reads as a distance (see distance.ts), which sits ahead of
 * Elevation. The title cell is skipped - "10 K" is a fine activity name. Any
 * unit counts, so swims listed in metres or yards and pages Strava renders
 * in another language are covered. A pool swim or a treadmill run shows a
 * distance without having a track; exporting one reports that Strava has no
 * such file.
 */
export function rowHasGps(row: HTMLTableRowElement): boolean {
	const cells = Array.from(row.cells).filter((td) => !td.classList.contains('sbgx-cell'));
	const marked = cells.find((td) => td.classList.contains('col-dist'));
	if (marked) return distanceShown(marked.textContent ?? '') === true;
	for (const td of cells) {
		if (td.querySelector('a[href*="/activities/"]')) continue;
		const shown = distanceShown(td.textContent ?? '');
		if (shown !== null) return shown;
	}
	return false;
}

/**
 * Whether a row can be exported in the current format. GPX and TCX need GPS
 * data; Strava answers them with a redirect for activities without it. An
 * indoor activity still has its Original file when one was uploaded - a
 * trainer ride's power, a strength session's heart rate.
 */
export function rowSelectable(row: HTMLTableRowElement): boolean {
	return row.dataset.sbgxHasGps === '1' || (row.dataset.sbgxHasGps === '0' && STATE.format === 'original');
}

/**
 * Selectable rows currently on screen, in table order, one per activity id
 * (Strava sometimes renders a sticky-header mirror or a transient duplicate
 * `<tr>` for the same activity).
 */
export function visibleSelectableRows(): HTMLTableRowElement[] {
	const seen = new Set<string>();
	const rows: HTMLTableRowElement[] = [];
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbgx-id]')) {
		const id = row.dataset.sbgxId;
		if (!id || seen.has(id) || !rowSelectable(row)) continue;
		seen.add(id);
		rows.push(row);
	}
	return rows;
}
