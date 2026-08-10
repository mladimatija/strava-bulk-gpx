/**
 * Shared types for the extension. Keeping them in one module avoids circular
 * imports between content.ts and downloader.ts.
 */

/** An activity surfaced from a Strava table row into our toolbar/downloader. */
export interface ActivityRow {
	/** Numeric Strava activity id, kept as a string for stable map/set keys. */
	id: string;
	/** Title text extracted from the row's first activity link. */
	name: string;
	/** Sport label, e.g. "Run", "Hike", "Workout". Best-effort. */
	sport_type: string;
}

/** Per-activity failure record returned by the bulk downloader. */
export interface BulkFailure {
	id: string;
	reason: string;
}

/** Final result of a bulk operation. */
export interface BulkResult {
	/** Count of activities that produced a usable GPX. */
	ok: number;
	/** Per-activity failures, in completion order. */
	failed: BulkFailure[];
}

/**
 * Discriminated event the bulk downloader emits so the UI can show progress.
 * Always update the spinner-bearing status when one of these arrives.
 *
 *   - 'downloading' - emitted before the first fetch and after every fetch
 *     completion (success or fail) with a running counter.
 *   - 'zipping'     - emitted once when bulk downloads switch from fetching
 *     to assembling the JSZip archive.
 *   - 'merging'     - emitted once when a merged-GPX run switches from
 *     fetching to parsing/combining the individual `<trk>` blocks into a
 *     single output document.
 */
export type ProgressEvent =
	{ stage: 'downloading'; completed: number; total: number } | { stage: 'zipping' } | { stage: 'merging' };

export type ProgressCallback = (event: ProgressEvent) => void;

/** Status kinds the toolbar can display. Maps to colour via data-kind in CSS. */
export type StatusKind = '' | 'info' | 'ok' | 'warn' | 'err';

/**
 * Which Strava export endpoint to hit. Maps directly to the URL segment:
 *   - 'gpx'      → /activities/<id>/export_gpx (route + waypoints, GPS-only)
 *   - 'tcx'      → /activities/<id>/export_tcx (route + HR/cadence/power lanes)
 *   - 'original' → /activities/<id>/export_original (raw file the user uploaded;
 *                  usually .fit from Garmin/Wahoo/etc., sometimes .gpx/.tcx)
 *
 * For 'gpx' and 'tcx' we know the extension up-front and name files
 * `strava_<id>.<ext>`. For 'original' the extension depends on what was
 * uploaded, so we parse `Content-Disposition` from Strava's response or fall
 * back to whatever the server suggested.
 */
export type ExportFormat = 'gpx' | 'tcx' | 'original';
