// The selection, saved so a reload doesn't lose it - selecting across many
// pages takes a while, and Strava reloads the page when you change some
// filters.
//
// Stored in chrome.storage.local next to the export history and never
// transmitted. Restored only within a day of the last change: a selection
// left over from last week would otherwise quietly join this week's backup.
// About 300 bytes per activity (its table columns are stored with it), so
// even 10k selected activities fit easily in the 10 MB quota.

import type { ActivityColumn, ActivityRow } from './types.ts';

const SELECTION_KEY = 'selection';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Batch the writes of a burst of changes (shift-click, a page of "select all"). */
const SAVE_DELAY_MS = 300;

interface Stored {
	savedAt: number;
	rows: ActivityRow[];
}

function isColumn(value: unknown): value is ActivityColumn {
	const col = value as ActivityColumn;
	return typeof value === 'object' && value !== null && typeof col.label === 'string' && typeof col.value === 'string';
}

/** Narrow one untrusted stored row; null when it's malformed. */
function parseRow(value: unknown): ActivityRow | null {
	if (typeof value !== 'object' || value === null) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== 'string' || !/^\d+$/.test(row.id)) return null;
	if (typeof row.name !== 'string' || typeof row.sport_type !== 'string') return null;
	return {
		id: row.id,
		name: row.name,
		sport_type: row.sport_type,
		date: typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null,
		hasGps: row.hasGps !== false,
		columns: Array.isArray(row.columns) ? row.columns.filter(isColumn) : [],
	};
}

/** The saved selection, or nothing when there is none or it's more than a day old. */
export async function loadSelection(): Promise<ActivityRow[]> {
	try {
		const stored = (await chrome.storage.local.get(SELECTION_KEY))[SELECTION_KEY] as Partial<Stored> | undefined;
		if (!stored || typeof stored.savedAt !== 'number' || Date.now() - stored.savedAt > MAX_AGE_MS) return [];
		if (!Array.isArray(stored.rows)) return [];
		return stored.rows.map(parseRow).filter((row): row is ActivityRow => row !== null);
	} catch {
		// Start with nothing selected - exports still work.
		return [];
	}
}

let saveTimer: number | undefined;

/** Save the selection shortly (best-effort); an empty one is removed. */
export function saveSelection(rows: () => ActivityRow[]): void {
	window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		const current = rows();
		const write =
			current.length === 0
				? chrome.storage.local.remove(SELECTION_KEY)
				: chrome.storage.local.set({ [SELECTION_KEY]: { savedAt: Date.now(), rows: current } satisfies Stored });
		write.catch((err: unknown) => {
			console.warn('Could not save the selection', err);
		});
	}, SAVE_DELAY_MS);
}
