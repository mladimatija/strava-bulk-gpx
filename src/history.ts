// Export history: which activities have already been exported, per format.
// Drives the ✓ beside each row button and the toolbar's "Select new", so a
// weekly backup is "Select new → Download selected".
//
// Stored in chrome.storage.local next to the toolbar preferences and never
// transmitted. Per format because a GPX backup isn't an Original backup.
// About 30 bytes per entry, so even 10k activities in all three formats use
// under 1 MB of the 10 MB quota.

import type { ExportFormat } from './types.ts';

/** Per format: activity id → when it was last exported (ms since epoch). */
type History = Record<ExportFormat, Record<string, number>>;

const HISTORY_KEY = 'exportHistory';
const FORMATS: readonly ExportFormat[] = ['gpx', 'tcx', 'original'];

function emptyHistory(): History {
	return { gpx: {}, tcx: {}, original: {} };
}

/** Narrow an untrusted stored value; anything malformed counts as not exported. */
function parseHistory(value: unknown): History {
	const history = emptyHistory();
	if (typeof value !== 'object' || value === null) return history;
	for (const format of FORMATS) {
		const entries = (value as Record<string, unknown>)[format];
		if (typeof entries !== 'object' || entries === null) continue;
		for (const [id, at] of Object.entries(entries as Record<string, unknown>)) {
			if (/^\d+$/.test(id) && typeof at === 'number') history[format][id] = at;
		}
	}
	return history;
}

let cache: History = emptyHistory();

/**
 * Load the history, and keep it in sync with writes from this or any other
 * tab - `onChange` runs after each, so the caller can re-render.
 */
export async function loadHistory(onChange: () => void): Promise<void> {
	try {
		const stored = await chrome.storage.local.get(HISTORY_KEY);
		cache = parseHistory(stored[HISTORY_KEY]);
	} catch {
		// No history - every activity counts as new, exports still work.
	}
	chrome.storage.onChanged.addListener((changes, area) => {
		const change = changes[HISTORY_KEY];
		if (area !== 'local' || !change) return;
		cache = parseHistory(change.newValue);
		onChange();
	});
}

/** When `id` was last exported in `format`, or null if never. */
export function exportedAt(id: string, format: ExportFormat): number | null {
	return cache[format][id] ?? null;
}

/** Number of recorded exports across all formats. */
export function exportedTotal(): number {
	return FORMATS.reduce((sum, format) => sum + Object.keys(cache[format]).length, 0);
}

/**
 * Record `ids` as exported in `format`, now. Re-reads storage first so an
 * export finishing in another tab at the same time isn't overwritten.
 */
export async function recordExports(ids: string[], format: ExportFormat): Promise<void> {
	if (ids.length === 0) return;
	const stored = await chrome.storage.local.get(HISTORY_KEY);
	const next = parseHistory(stored[HISTORY_KEY]);
	const now = Date.now();
	for (const id of ids) next[format][id] = now;
	cache = next;
	await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

/** Forget every recorded export, in every format. */
export async function clearHistory(): Promise<void> {
	cache = emptyHistory();
	await chrome.storage.local.remove(HISTORY_KEY);
}
