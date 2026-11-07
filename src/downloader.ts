// Single + bulk download via Strava's native export endpoints:
//   - /activities/<id>/export_gpx       (route as GPX 1.1)
//   - /activities/<id>/export_tcx       (route as TCX with HR/cadence/power lanes)
//   - /activities/<id>/export_original  (raw upload file - .fit, .gpx, .tcx, etc.)
//
// These are the same URLs strava.com's own "Export" menu uses, so the files
// the user gets are byte-for-byte identical to clicking those links manually.
//
// All requests are same-origin from the content script's standpoint, so the
// browser auto-attaches the user's session cookies - no cookie permission or
// host_permissions needed.

import JSZip from 'jszip';
import { activitiesCsv } from './csv.ts';
import type { ActivityRow, BulkFailure, BulkResult, ExportFormat, NamePattern, ProgressCallback } from './types.ts';

/** Build the URL for a given activity + format. */
function exportUrl(id: string, format: ExportFormat): string {
	return `/activities/${id}/export_${format}`;
}

/** Tell the browser to download a same-origin URL with our chosen filename. */
function downloadViaAnchor(href: string, filename: string | null): void {
	const a = document.createElement('a');
	a.href = href;
	if (filename) a.download = filename;
	// If filename is null (original-format case), omit the download attribute
	// so the browser uses the Content-Disposition the server returns.
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/** Tell the browser to download a Blob with our chosen filename. */
function downloadBlob(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Today as YYYY-MM-DD, for batch filenames. */
function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Parse a `Content-Disposition: attachment; filename="…"` header. Handles both
 * the bare `filename=` form and the RFC 5987 `filename*=UTF-8''…` form Strava
 * sometimes emits for non-ASCII activity titles.
 */
function parseContentDispositionFilename(value: string | null): string | null {
	if (!value) return null;
	// Try the UTF-8-encoded form first (filename*=UTF-8''…), then the plain form.
	const rfc5987 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
	if (rfc5987?.[1]) {
		try {
			return decodeURIComponent(rfc5987[1]).trim() || null;
		} catch {
			/* fall through to the plain form */
		}
	}
	const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
	return plain?.[1]?.trim() ?? null;
}

/** Sanitize a server-suggested filename so it's safe to use as a zip entry. */
function sanitizeFilename(name: string): string {
	return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'activity';
}

/** Activity titles can be long; cap them so paths stay manageable. */
const MAX_SEGMENT_LENGTH = 80;

/**
 * Turn free text (an activity title or sport) into one safe path segment:
 * no control characters, collapsed whitespace, capped length, and no
 * trailing dots/spaces (Windows refuses to create those).
 */
function pathSegment(text: string): string {
	const cleaned = sanitizeFilename(text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' '));
	return cleaned.slice(0, MAX_SEGMENT_LENGTH).replace(/[. ]+$/, '') || 'activity';
}

/** Extension of a filename including the dot - `.fit`, `.fit.gz` - or "" when there is none. */
function fileExtension(name: string): string {
	return /(\.[a-z0-9]{1,5}(?:\.gz)?)$/i.exec(name)?.[1] ?? '';
}

/**
 * Where an activity's file goes: a path inside the zip (possibly with a
 * sport folder), or - via {@link baseName} - a single download's filename.
 * `serverName` is Strava's Content-Disposition filename, which carries the
 * original upload's extension; it's ignored for GPX/TCX.
 */
function activityFilePath(
	activity: ActivityRow,
	format: ExportFormat,
	names: NamePattern,
	serverName: string | null,
): string {
	if (names === 'id') {
		// Original keeps the uploaded file's own name, as it always has.
		if (format === 'original') return serverName ? sanitizeFilename(serverName) : `strava_${activity.id}`;
		return `strava_${activity.id}.${format}`;
	}
	const ext = format === 'original' ? fileExtension(serverName ?? '') : `.${format}`;
	const file = `${activity.id}_${pathSegment(activity.name)}${ext}`;
	const sport = activity.sport_type.trim();
	return names === 'sport' && sport ? `${pathSegment(sport)}/${file}` : file;
}

/** Last segment of a zip path - browsers can't create folders from a download. */
function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Claim `path` in `used`, appending -2, -3, … before the extension when it's
 * taken. Compared case-insensitively, since macOS and Windows file systems
 * would collide on extraction anyway.
 */
function uniquePath(path: string, used: Set<string>): string {
	const ext = fileExtension(path);
	const stem = path.slice(0, path.length - ext.length);
	let candidate = path;
	for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
	used.add(candidate.toLowerCase());
	return candidate;
}

/**
 * Per-row download. Usually a same-origin anchor click - Strava streams the
 * file via the browser's download manager, which handles the actual writing
 * out of band.
 *
 * The exception is Original with a custom name pattern: the extension we need
 * only arrives in the response headers, so we fetch the file and save the blob.
 */
export async function downloadSingle(
	activity: ActivityRow,
	format: ExportFormat,
	names: NamePattern = 'id',
): Promise<void> {
	const id = String(activity.id);
	if (format !== 'original') {
		downloadViaAnchor(exportUrl(id, format), baseName(activityFilePath(activity, format, names, null)));
		return;
	}
	if (names === 'id') {
		downloadViaAnchor(exportUrl(id, format), null);
		return;
	}
	const res = await fetch(exportUrl(id, format), { method: 'GET', credentials: 'same-origin' });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const serverName = parseContentDispositionFilename(res.headers.get('content-disposition'));
	downloadBlob(baseName(activityFilePath(activity, format, names, serverName)), await res.blob());
}

/** Backwards-compatible alias - older callers passed no format and expected GPX. */
export function downloadSingleGpx(activity: ActivityRow): Promise<void> {
	return downloadSingle(activity, 'gpx');
}

/** Save a CSV of the given activities' table columns. No network involved. */
export function downloadActivitiesCsv(activities: ActivityRow[]): void {
	const blob = new Blob([activitiesCsv(activities)], { type: 'text/csv;charset=utf-8' });
	downloadBlob(`strava_activities_${today()}.csv`, blob);
}

export interface BulkOptions {
	/**
	 * Notified as the download progresses through its stages. See {@link ProgressEvent}.
	 */
	onProgress?: ProgressCallback;
	/** Aborting stops all fetches and rejects the run - nothing gets saved. */
	signal?: AbortSignal;
	/** How files are named inside the zip. Defaults to `strava_<id>.<ext>`. */
	names?: NamePattern;
}

// Modest concurrency. The export endpoint is comfortable with parallel
// requests from a logged-in browser session; 3 in flight is a sane balance
// between throughput and politeness.
const CONCURRENCY = 3;

/** Retry a throttled (HTTP 429) request at most this many times before giving up on it. */
const MAX_THROTTLE_RETRIES = 3;

/**
 * Seconds to wait before retrying a 429: Strava's Retry-After (seconds or an
 * HTTP date) when present, else exponential backoff (5 s, 10 s, 20 s).
 * Clamped to 1-60 s so a bad header can't stall the run indefinitely.
 */
function retryDelaySeconds(res: Response, attempt: number): number {
	let seconds = 5 * 2 ** attempt;
	const header = res.headers.get('retry-after');
	if (header) {
		const parsed = /^\s*\d+\s*$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
		if (Number.isFinite(parsed)) seconds = parsed;
	}
	return Math.min(60, Math.max(1, Math.ceil(seconds)));
}

/** Wait `ms`, returning early if `signal` aborts (the caller's next fetch then rejects). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Fetch every activity's export with {@link CONCURRENCY} requests in flight,
 * handing each successful response to `onResponse` (with the activity's input
 * index, so callers can keep input order). Emits 'downloading' progress before
 * the first fetch and after each one settles.
 *
 * A 429 pauses the whole pool - once Strava throttles one request the others
 * would hit the same limit - then retries that activity, up to
 * {@link MAX_THROTTLE_RETRIES} times before recording it as failed.
 *
 * Resolves with the per-activity failures in completion order. Rejects with
 * the signal's reason if `signal` aborts.
 */
async function fetchAll(
	activities: ActivityRow[],
	format: ExportFormat,
	{ onProgress, signal }: BulkOptions,
	onResponse: (activity: ActivityRow, res: Response, index: number) => Promise<void>,
): Promise<BulkFailure[]> {
	const total = activities.length;
	const failed: BulkFailure[] = [];
	let completed = 0;
	let cursor = 0;
	// Shared across workers: nobody fetches before this timestamp.
	let resumeAt = 0;

	async function fetchThrottled(id: string): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			const wait = resumeAt - Date.now();
			if (wait > 0) await sleep(wait, signal);
			const res = await fetch(exportUrl(id, format), { method: 'GET', credentials: 'same-origin', signal });
			if (res.status !== 429 || attempt >= MAX_THROTTLE_RETRIES) return res;
			const seconds = retryDelaySeconds(res, attempt);
			resumeAt = Math.max(resumeAt, Date.now() + seconds * 1000);
			onProgress?.({ stage: 'throttled', seconds });
		}
	}

	onProgress?.({ stage: 'downloading', completed, total });
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (cursor < total && !signal?.aborted) {
				const i = cursor++;
				const a = activities[i]!;
				try {
					const res = await fetchThrottled(a.id);
					if (!res.ok) {
						failed.push({ id: a.id, reason: `HTTP ${res.status}` });
					} else {
						await onResponse(a, res, i);
					}
				} catch (e) {
					// An abort surfaces here as a rejected fetch/body read -
					// that's not a per-activity failure, just stop.
					if (signal?.aborted) return;
					const message = e instanceof Error ? e.message : String(e);
					failed.push({ id: a.id, reason: message });
				}
				completed++;
				// While the pool is paused, other workers' in-flight requests
				// still land - keep showing the wait rather than flipping
				// straight back to the counter.
				const pausedFor = Math.ceil((resumeAt - Date.now()) / 1000);
				onProgress?.(
					pausedFor > 0 ? { stage: 'throttled', seconds: pausedFor } : { stage: 'downloading', completed, total },
				);
			}
		}),
	);
	signal?.throwIfAborted();
	return failed;
}

/** Name of the activity summary added to every multi-file zip. */
const CSV_NAME = 'activities.csv';

/**
 * Bulk download. One id → one file (no zip). Multiple ids → zip, with an
 * `activities.csv` summary next to the files.
 *
 * Emits progress as a discriminated event:
 *   - { stage: "downloading", completed, total } - fires immediately and after
 *     every fetch finishes (success or fail), so the caller can keep a counter
 *     in sync.
 *   - { stage: "throttled", seconds } - Strava rate-limited us; see {@link fetchAll}.
 *   - { stage: "zipping" } - fires once when fetches are done and JSZip starts
 *     assembling. Useful for keeping a spinner alive during what can be a
 *     multi-second client-side step on large batches.
 *
 * Resolves with the count of successes and a list of per-activity failures.
 * Throws if *every* activity failed, or if `signal` aborts.
 */
export async function downloadBulk(
	activities: ActivityRow[],
	format: ExportFormat,
	options: BulkOptions = {},
): Promise<BulkResult> {
	const { onProgress, signal, names = 'id' } = options;
	if (activities.length === 0) return { ok: 0, failed: [] };
	if (activities.length === 1) {
		await downloadSingle(activities[0]!, format, names);
		return { ok: 1, failed: [] };
	}

	const zip = new JSZip();
	/** Activity id → path inside the zip, for the CSV's File column. */
	const files = new Map<string, string>();
	// Reserve the summary's name so no activity file can overwrite it.
	const used = new Set<string>([CSV_NAME]);

	const failed = await fetchAll(activities, format, options, async (a, res) => {
		const blob = await res.blob();
		// GPX/TCX: known extension. Original: the server's filename carries
		// the uploaded file's extension (and, for the 'id' pattern, the
		// whole name).
		const serverName =
			format === 'original' ? parseContentDispositionFilename(res.headers.get('content-disposition')) : null;
		// JSZip silently replaces an entry with the same name, so two uploads
		// that share a filename would otherwise lose one file.
		const path = uniquePath(activityFilePath(a, format, names, serverName), used);
		zip.file(path, blob);
		files.set(a.id, path);
	});

	if (files.size === 0) {
		throw new Error(`All ${activities.length} downloads failed. First error: ${failed[0]?.reason ?? 'unknown'}`);
	}

	onProgress?.({ stage: 'zipping' });
	zip.file(
		CSV_NAME,
		activitiesCsv(
			activities.filter((a) => files.has(a.id)),
			files,
		),
	);
	const blob = await zip.generateAsync({
		type: 'blob',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
	});
	// Cancel may land while JSZip is compressing; honour it before saving.
	signal?.throwIfAborted();
	// Zip filename mentions the format, so a user with several batches doesn't
	// confuse strava_gpx_…zip with strava_tcx_…zip in their Downloads folder.
	downloadBlob(`strava_${format}_${today()}.zip`, blob);
	return { ok: files.size, failed };
}

/** Backwards-compatible alias - older callers passed no format and expected GPX. */
export function downloadBulkGpx(activities: ActivityRow[], options: BulkOptions = {}): Promise<BulkResult> {
	return downloadBulk(activities, 'gpx', options);
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

interface MergeSource {
	id: string;
	name: string;
	xml: string;
}

/**
 * When a GPX document starts, in ms since the epoch: its first track point's
 * `<time>`, else the first `<time>` anywhere (Strava puts the start time in
 * `<metadata>`). NaN when it has none.
 */
function gpxStartTime(doc: Document): number {
	const firstPoint = doc.getElementsByTagName('trkpt')[0];
	const time = firstPoint?.getElementsByTagName('time')[0] ?? doc.getElementsByTagName('time')[0];
	return Date.parse(time?.textContent ?? '');
}

/**
 * Assemble a single GPX 1.1 document by concatenating the `<wpt>`, `<rte>`,
 * and `<trk>` children of every source GPX. The output preserves namespaces,
 * including any Strava-specific extensions on track points (heart rate,
 * cadence, etc.) - `importNode(node, true)` copies the whole subtree without
 * stripping anything.
 *
 * Sources are ordered by start time, so a multi-day trip reads day 1 → day N
 * whatever order the rows were listed or fetched in. Sources without any
 * timestamp keep their relative order, after the timed ones.
 *
 * If a source `<trk>` has no `<name>` child, we inject one using the activity
 * title, so the merged file is still readable in tools like Garmin BaseCamp
 * that list tracks by name.
 */
function mergeGpxDocuments(sources: MergeSource[]): string {
	const parser = new DOMParser();
	const serializer = new XMLSerializer();

	const outDoc = parser.parseFromString(
		`<?xml version="1.0" encoding="UTF-8"?>` +
			`<gpx version="1.1" creator="Strava Bulk GPX Export" ` +
			`xmlns="${GPX_NS}" ` +
			`xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
			`xsi:schemaLocation="${GPX_NS} http://www.topografix.com/GPX/1/1/gpx.xsd"/>`,
		'application/xml',
	);
	const root = outDoc.documentElement;

	const parsed = sources
		.map((src) => {
			const doc = parser.parseFromString(src.xml, 'application/xml');
			return { src, doc, start: gpxStartTime(doc) };
		})
		// DOMParser returns an error document with a <parsererror> root rather
		// than throwing on malformed XML. Skip those - the activity will still
		// be counted as a successful fetch upstream, but its content can't be
		// merged. (Better than corrupting the whole output.)
		.filter(({ doc }) => doc.getElementsByTagName('parsererror').length === 0)
		.sort((a, b) => {
			const aUntimed = Number.isNaN(a.start);
			const bUntimed = Number.isNaN(b.start);
			if (aUntimed || bUntimed) return Number(aUntimed) - Number(bUntimed);
			return a.start - b.start;
		});

	// The GPX schema wants every <wpt> first, then every <rte>, then every
	// <trk> - across the whole document, not per source. Strava's exports are
	// pure <trk> in practice, but a source with waypoints must not end up
	// after another source's tracks.
	for (const { doc } of parsed) {
		for (const wpt of Array.from(doc.getElementsByTagName('wpt'))) {
			root.appendChild(outDoc.importNode(wpt, true));
		}
	}
	for (const { doc } of parsed) {
		for (const rte of Array.from(doc.getElementsByTagName('rte'))) {
			root.appendChild(outDoc.importNode(rte, true));
		}
	}
	for (const { src, doc } of parsed) {
		for (const trk of Array.from(doc.getElementsByTagName('trk'))) {
			const imported = outDoc.importNode(trk, true);
			if (!imported.getElementsByTagName('name')[0] && src.name) {
				const nameEl = outDoc.createElementNS(GPX_NS, 'name');
				nameEl.textContent = src.name;
				imported.insertBefore(nameEl, imported.firstChild);
			}
			root.appendChild(imported);
		}
	}

	return `<?xml version="1.0" encoding="UTF-8"?>\n${serializer.serializeToString(outDoc)}`;
}

/**
 * Merge mode. Fetches `/export_gpx` for every selected activity, parses each
 * one, and emits a single combined GPX file. The output is one `<gpx>` root
 * with N `<trk>` children in chronological order - useful for stitching
 * together a multi-day trip into a single track collection a mapping tool
 * can render in one go.
 *
 * Progress events mirror {@link downloadBulk} but the post-fetch stage is
 * `'merging'` instead of `'zipping'` so the UI can show the right string.
 *
 * Resolves with the count of activities that contributed to the merged file
 * and a list of per-activity failures. Throws if *every* fetch failed, or if
 * `options.signal` aborts.
 */
export async function downloadMergedGpx(activities: ActivityRow[], options: BulkOptions = {}): Promise<BulkResult> {
	if (activities.length === 0) return { ok: 0, failed: [] };

	// Indexed by input position rather than pushed as fetches finish, so the
	// merge never depends on which response happened to arrive first.
	const fetched: (MergeSource | undefined)[] = [];
	const failed = await fetchAll(activities, 'gpx', options, async (a, res, i) => {
		fetched[i] = { id: a.id, name: a.name, xml: await res.text() };
	});
	const sources = fetched.filter((s): s is MergeSource => s !== undefined);

	if (sources.length === 0) {
		throw new Error(`All ${activities.length} downloads failed. First error: ${failed[0]?.reason ?? 'unknown'}`);
	}

	options.onProgress?.({ stage: 'merging' });
	const merged = mergeGpxDocuments(sources);
	options.signal?.throwIfAborted();
	const blob = new Blob([merged], { type: 'application/gpx+xml' });
	downloadBlob(`strava_merged_${today()}.gpx`, blob);
	return { ok: sources.length, failed };
}
