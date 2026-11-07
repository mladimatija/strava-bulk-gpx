// CSV summary of exported activities - the `activities.csv` inside bulk zips
// (mirroring Strava's own account archive) and the toolbar's "Export list".
//
// Columns are whatever Strava's table shows, labelled by its own (localized)
// headers, so we never hard-code Strava's column layout.

import { t } from './i18n.ts';
import type { ActivityRow } from './types.ts';

/**
 * Quote a cell per RFC 4180, and defuse values a spreadsheet would run as a
 * formula (OWASP "CSV injection") - activity titles are free text.
 */
function csvCell(value: string): string {
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Build the CSV. `files` maps activity id → path inside the zip; pass it to
 * add a File column (bulk zips), omit it for a list-only export.
 *
 * Starts with a UTF-8 BOM so Excel doesn't mangle non-ASCII titles, and uses
 * CRLF line endings per RFC 4180.
 */
export function activitiesCsv(activities: ActivityRow[], files?: Map<string, string>): string {
	// Union of column labels in first-seen order. Every row comes from the
	// same table, so in practice this is just that table's header.
	const labels: string[] = [];
	for (const a of activities) {
		for (const col of a.columns) if (!labels.includes(col.label)) labels.push(col.label);
	}

	const header = [t('csvActivityId'), t('csvActivityUrl'), ...(files ? [t('csvFile')] : []), ...labels];
	const lines = [header];
	for (const a of activities) {
		const values = new Map(a.columns.map((col) => [col.label, col.value]));
		lines.push([
			a.id,
			new URL(`/activities/${a.id}`, location.origin).href,
			...(files ? [files.get(a.id) ?? ''] : []),
			...labels.map((label) => values.get(label) ?? ''),
		]);
	}
	return '\uFEFF' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
