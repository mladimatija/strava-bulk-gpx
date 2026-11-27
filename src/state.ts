// The content script's state and saved preferences: what's selected, which
// format and options the toolbar shows, and what is running. One module-level
// object, shared by the modules that render the toolbar and the rows.

import type { DateOrder } from './dates.ts';
import { t } from './i18n.ts';
import type { ActivityRow, ExportFormat, MergeMode, NamePattern } from './types.ts';
import { defaultLengthUnit, type LengthUnit } from './units.ts';

/** An activity that failed in the last run, with the reason shown to the user. */
export interface FailedActivity {
	activity: ActivityRow;
	reason: string;
}

export interface State {
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
	/** The radius as the user chose it, for the chip: "500 m", "650 ft". */
	trimLabel: string;
	/**
	 * What the Hide start/end menu shows - the dropdown's value, and a custom
	 * distance as typed with its unit - so a rebuilt toolbar shows it too.
	 */
	trimMenu: { choice: string; customValue: string; unit: LengthUnit };
	/** Start a new zip after this many MB of files, 0 = never split. */
	splitMb: number;
	/**
	 * Day/month order of the table's dates, once any row settles it (see
	 * dates.ts). Not saved: it's re-learned from the rows on every load.
	 */
	dateOrder: DateOrder | null;
	/** Aborts the in-flight bulk/merge run; null when idle. */
	abort: AbortController | null;
	/**
	 * Failures from the last run, listed under the toolbar. `retryFormat` is
	 * set for zip and folder runs (retrying fetches only the failed ones,
	 * into `retryDir` when the run wrote to a folder); merge runs leave it
	 * null - re-merging just the failures would drop the rest.
	 */
	lastRun: {
		failed: FailedActivity[];
		retryFormat: ExportFormat | null;
		retryDir: FileSystemDirectoryHandle | null;
	} | null;
	/** Row last toggled - the anchor for shift-click range selection. */
	anchorId: string | null;
	/**
	 * A zip part waiting for its "Save part N" click (see waitForPartClick);
	 * null when none is.
	 */
	pendingPart: { n: number; save: () => void } | null;
	/** Select all pages is running: the selection is saved once, at the end. */
	selectingPages: boolean;
}

export const STATE: State = {
	selected: new Map<string, ActivityRow>(),
	toolbar: null,
	busy: false,
	format: 'gpx',
	names: 'id',
	mergeMode: 'tracks',
	trim: 0,
	trimLabel: '',
	trimMenu: { choice: '0', customValue: '', unit: defaultLengthUnit(navigator.language) },
	splitMb: 500,
	dateOrder: null,
	abort: null,
	lastRun: null,
	anchorId: null,
	pendingPart: null,
	selectingPages: false,
};

export const FORMAT_STORAGE_KEY = 'exportFormat';
export const NAMES_STORAGE_KEY = 'namePattern';
export const MERGE_MODE_STORAGE_KEY = 'mergeMode';
export const SPLIT_STORAGE_KEY = 'zipSplitMb';

/** Narrow an untrusted stored value to a known format, defaulting to gpx. */
export function parseFormat(value: unknown): ExportFormat {
	return value === 'tcx' || value === 'original' ? value : 'gpx';
}

/** Narrow an untrusted stored value to a known name pattern, defaulting to id. */
export function parseNames(value: unknown): NamePattern {
	return value === 'title' || value === 'sport' || value === 'date' ? value : 'id';
}

/** Narrow an untrusted stored value to a known merge mode, defaulting to tracks. */
export function parseMergeMode(value: unknown): MergeMode {
	return value === 'single' || value === 'geojson' ? value : 'tracks';
}

/** Zip split sizes offered in the "⋯" menu, in MB (0 = never). */
export const SPLIT_SIZES_MB = [250, 500, 1000, 0];

/** Narrow an untrusted stored value to a split size in MB, defaulting to 500. */
export function parseSplit(value: unknown): number {
	const mb = Number(value);
	return value !== '' && value !== null && Number.isFinite(mb) && mb >= 0 ? mb : 500;
}

/** "250 MB", "1 GB". */
export function sizeLabel(mb: number): string {
	return mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
}

/** Hide start/end radii offered in the "⋯" menu, in metres. */
export const TRIM_RADII = [200, 500, 1000];

/** Narrow a trim select value to an offered radius, or 0 (off). */
export function parseTrim(value: string): number {
	const radius = Number(value);
	return TRIM_RADII.includes(radius) ? radius : 0;
}

/** "200 m", "1 km". */
export function radiusLabel(metres: number): string {
	return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}

/** The trim radius that applies right now - Original files aren't trimmed. */
export function effectiveTrim(): number {
	return STATE.format !== 'original' ? STATE.trim : 0;
}

/** Restore the last-used toolbar settings; storage failures keep the defaults. */
export async function loadPreferences(): Promise<void> {
	try {
		const stored = await chrome.storage.local.get([
			FORMAT_STORAGE_KEY,
			NAMES_STORAGE_KEY,
			MERGE_MODE_STORAGE_KEY,
			SPLIT_STORAGE_KEY,
		]);
		STATE.format = parseFormat(stored[FORMAT_STORAGE_KEY]);
		STATE.names = parseNames(stored[NAMES_STORAGE_KEY]);
		STATE.mergeMode = parseMergeMode(stored[MERGE_MODE_STORAGE_KEY]);
		STATE.splitMb = parseSplit(stored[SPLIT_STORAGE_KEY] ?? 500);
	} catch {
		// Keep the defaults - a broken storage area shouldn't block exports.
	}
}

/** Persist a toolbar preference for the next page load (best-effort). */
export function savePreference(key: string, value: string): void {
	chrome.storage.local.set({ [key]: value }).catch((err: unknown) => {
		console.warn(`Could not save ${key}`, err);
	});
}

/** Human-readable label for a format, from the i18n bundle. */
export function formatLabel(format: ExportFormat): string {
	if (format === 'gpx') return t('gpxButton');
	if (format === 'tcx') return t('formatTcx');
	return t('formatOriginal');
}
