// Single + bulk download via Strava's native export endpoints:
//   - /activities/<id>/export_gpx       (route as GPX 1.1)
//   - /activities/<id>/export_tcx       (route as TCX with HR/cadence/power lanes)
//   - /activities/<id>/export_original  (raw upload file - .fit, .gpx, .tcx, etc.)
//
// These are the same URLs strava.com's own "Export" menu uses, so the files
// the user gets are byte-for-byte identical to clicking those links manually
// (except trimmed and merged files, which are built from them).
//
// All requests are same-origin from the content script's standpoint, so the
// browser auto-attaches the user's session cookies - no cookie permission or
// host_permissions needed.

import { activitiesCsv } from './csv.ts';
import { existingSize, writeFile } from './folder.ts';
import { t } from './i18n.ts';
import { mergeGeoJson, mergeGpxDocuments, mergeTcxDocuments, type MergeSource } from './merge.ts';
import { trimGpx, trimTcx } from './trim.ts';
import type {
	ActivityRow,
	BulkFailure,
	BulkResult,
	ExportFormat,
	MergeMode,
	NamePattern,
	ProgressCallback,
} from './types.ts';
import { ZipPart } from './zip.ts';

/** Build the URL for a given activity + format. */
function exportUrl(id: string, format: ExportFormat): string {
	return `/activities/${id}/export_${format}`;
}

/**
 * Why an export response isn't a file, or null when it is. Strava answers
 * an export that doesn't exist - GPX or TCX of an activity without GPS,
 * Original of a manual entry - with a redirect to an HTML page, and a
 * signed-out session with a redirect to the login page. Both arrive as
 * HTTP 200 after the redirect, so `res.ok` alone would save a web page. A
 * redirect that ends in a file (say, on a CDN) is fine.
 */
export function exportProblem(
	res: Pick<Response, 'ok' | 'status' | 'url' | 'headers'>,
	format: ExportFormat,
): string | null {
	if (!res.ok) return `HTTP ${res.status}`;
	if (!(res.headers.get('content-type') ?? '').includes('text/html')) return null;
	// A fetch response's url is absolute: where the redirects ended.
	if (/^https?:\/\/[^/]+\/(login|session)\b/.test(res.url)) return t('notLoggedIn');
	return t('exportUnavailable', format === 'original' ? t('formatOriginal') : format.toUpperCase());
}

/** Retry a throttled (HTTP 429) request at most this many times before giving up on it. */
const MAX_THROTTLE_RETRIES = 3;

/**
 * Seconds to wait before retrying a 429: Strava's Retry-After (seconds or an
 * HTTP date) when present, else exponential backoff (5 s, 10 s, 20 s).
 * Clamped to 1-60 s so a bad header can't stall the run indefinitely.
 */
export function retryDelaySeconds(res: Pick<Response, 'headers'>, attempt: number, now = Date.now()): number {
	let seconds = 5 * 2 ** attempt;
	const header = res.headers.get('retry-after');
	if (header) {
		const parsed = /^\s*\d+\s*$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
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
 * The pause shared by the requests of one run: once Strava throttles one
 * request the others would hit the same limit, so nobody fetches before
 * `resumeAt`.
 */
interface Throttle {
	resumeAt: number;
}

/**
 * Fetch an activity's export, waiting out Strava's rate limit: a 429 pauses
 * everything sharing `throttle` for Strava's Retry-After, then the request
 * is retried - up to {@link MAX_THROTTLE_RETRIES} times, after which the 429
 * is returned like any other response. Used by row downloads as much as by
 * bulk runs, so a single click during a throttled spell waits too.
 */
async function fetchThrottled(
	id: string,
	format: ExportFormat,
	throttle: Throttle,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const wait = throttle.resumeAt - Date.now();
		if (wait > 0) await sleep(wait, signal);
		const res = await fetch(exportUrl(id, format), { method: 'GET', credentials: 'same-origin', signal });
		if (res.status !== 429 || attempt >= MAX_THROTTLE_RETRIES) return res;
		const seconds = retryDelaySeconds(res, attempt);
		throttle.resumeAt = Math.max(throttle.resumeAt, Date.now() + seconds * 1000);
		onProgress?.({ stage: 'throttled', seconds });
	}
}

/** Apply Hide start/end to a GPX or TCX export. */
function trimExport(xml: string, format: 'gpx' | 'tcx', radiusM: number): string {
	return format === 'gpx' ? trimGpx(xml, radiusM) : trimTcx(xml, radiusM);
}

/** MIME type of a saved GPX or TCX file. */
function xmlType(format: 'gpx' | 'tcx'): string {
	return format === 'gpx' ? 'application/gpx+xml' : 'application/vnd.garmin.tcx+xml';
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
 * Parse a `Content-Disposition: attachment; filename="…"` header: the
 * RFC 5987 `filename*=<charset>'<lang>'…` form Strava sometimes emits for
 * non-ASCII activity titles (UTF-8, or else read byte by byte as
 * ISO-8859-1), then the plain `filename=` form, quoted (with `\"` escapes)
 * or bare.
 */
export function parseContentDispositionFilename(value: string | null): string | null {
	if (!value) return null;
	const extended = /filename\*\s*=\s*([\w!#$&+.^`|~-]+)'[^']*'([^;]+)/i.exec(value);
	if (extended?.[1] && extended[2]) {
		const [, charset, encoded] = extended;
		try {
			const decoded = /^utf-?8$/i.test(charset)
				? decodeURIComponent(encoded)
				: encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
			if (decoded.trim()) return decoded.trim();
		} catch {
			/* fall through to the plain form */
		}
	}
	const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value);
	if (quoted?.[1]) return quoted[1].replace(/\\(.)/g, '$1').trim() || null;
	// Starts with a non-space, so the trimmed name is never empty.
	return /filename\s*=\s*([^;"\s][^;"]*)/i.exec(value)?.[1]?.trim() ?? null;
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
 * The extension an Original upload's bytes point to, for when Strava's
 * Content-Disposition doesn't give one: `.fit` (".FIT" at byte 8, per the
 * FIT header), `.gz`, `.gpx` / `.tcx` by root element, or "" when unknown.
 */
export function sniffExtension(bytes: Uint8Array): string {
	const head = bytes.subarray(0, 512);
	if (head[0] === 0x1f && head[1] === 0x8b) return '.gz';
	if (String.fromCharCode(...head.subarray(8, 12)) === '.FIT') return '.fit';
	const text = new TextDecoder().decode(head);
	if (/<gpx[\s>]/.test(text)) return '.gpx';
	if (/<TrainingCenterDatabase[\s>]/.test(text)) return '.tcx';
	return '';
}

/**
 * An Original upload's file name: Strava's Content-Disposition name, with an
 * extension sniffed from the bytes when it has none - or `strava_<id>` plus
 * that extension when there's no usable header.
 */
function originalFileName(res: Response, bytes: Uint8Array, id: string): string {
	const name = parseContentDispositionFilename(res.headers.get('content-disposition'));
	if (name && fileExtension(name)) return name;
	return `${name ?? `strava_${id}`}${sniffExtension(bytes)}`;
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
		// Original keeps the uploaded file's own name (see originalFileName).
		if (format === 'original') return serverName ? sanitizeFilename(serverName) : `strava_${activity.id}`;
		return `strava_${activity.id}.${format}`;
	}
	const ext = format === 'original' ? fileExtension(serverName ?? '') : `.${format}`;
	// Without a date, fall back to the id: it keeps the name unique.
	const prefix = names === 'date' && activity.date ? activity.date : activity.id;
	const file = `${prefix}_${pathSegment(activity.name)}${ext}`;
	const sport = activity.sport_type.trim();
	return names === 'sport' && sport ? `${pathSegment(sport)}/${file}` : file;
}

/** `strava_1.gpx` → `strava_1_trimmed.gpx`: a trimmed file is no longer Strava's own export. */
function trimmedName(path: string): string {
	return path.replace(/\.(gpx|tcx)$/, '_trimmed.$1');
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

/** An activity's export, ready to save: where it goes and its bytes. */
interface ExportFile {
	/** Path inside a zip or folder; a single download uses its last segment. */
	path: string;
	data: Uint8Array<ArrayBuffer>;
}

/**
 * Read a fetched export into the file to save: trimmed first when
 * `trimRadius` is set (GPX/TCX only), and named by `names` - an Original by
 * Strava's own file name, or its bytes (see {@link originalFileName}).
 *
 * Throws, with a reason fit for the failure list, when a track would be
 * trimmed down to nothing.
 */
async function exportFile(
	activity: ActivityRow,
	res: Response,
	format: ExportFormat,
	names: NamePattern,
	trimRadius: number,
): Promise<ExportFile> {
	if (format !== 'original' && trimRadius > 0) {
		const xml = trimExport(await res.text(), format, trimRadius);
		const path = trimmedName(activityFilePath(activity, format, names, null));
		return { path, data: new TextEncoder().encode(xml) };
	}
	const data = new Uint8Array(await res.arrayBuffer());
	const serverName = format === 'original' ? originalFileName(res, data, activity.id) : null;
	return { path: activityFilePath(activity, format, names, serverName), data };
}

/** MIME type of a saved export. */
function fileType(format: ExportFormat): string {
	return format === 'original' ? 'application/octet-stream' : xmlType(format);
}

/**
 * Per-row download: fetch the export, check that it's a file
 * ({@link exportProblem}), and save it under our name - trimmed first when
 * `trimRadius` is set. Fetching rather than linking is what lets a missing
 * export be reported: Strava answers one with a redirect to a web page,
 * which an anchor would save as the file (or navigate to).
 *
 * A rate-limited request waits and retries like a bulk run's
 * ({@link fetchThrottled}); `onProgress` hears about the wait.
 */
export async function downloadSingle(
	activity: ActivityRow,
	format: ExportFormat,
	names: NamePattern = 'id',
	trimRadius = 0,
	onProgress?: ProgressCallback,
): Promise<void> {
	const res = await fetchThrottled(activity.id, format, { resumeAt: 0 }, undefined, onProgress);
	const problem = exportProblem(res, format);
	if (problem) throw new Error(problem);
	const { path, data } = await exportFile(activity, res, format, names, trimRadius);
	downloadBlob(baseName(path), new Blob([data], { type: fileType(format) }));
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
	/**
	 * Aborting stops all fetches and rejects the run. Nothing more is saved -
	 * but zip parts and folder files saved before then stay saved (see `onSaved`).
	 */
	signal?: AbortSignal;
	/** How files are named. Defaults to `strava_<id>.<ext>`. */
	names?: NamePattern;
	/**
	 * Hide start/end: hide GPX/TCX locations within this many metres of each
	 * activity's start and end (see trim.ts). 0 or absent = off; ignored for
	 * Original.
	 */
	trimRadius?: number;
	/**
	 * Zips only: start a new zip once the files in the current one add up to
	 * this many bytes (before compression), saving each as soon as it's full
	 * so a large backup never sits in memory whole. 0 or absent = one zip.
	 */
	splitBytes?: number;
	/**
	 * Zips and folders: called with the ids of the activities in each saved
	 * file - every zip part, the lone file of a single-activity download, or
	 * a batch of files written to a folder - so the caller can record exports
	 * that were saved even if a later part fails or the run is cancelled.
	 */
	onSaved?: (ids: string[]) => void;
	/**
	 * Split zips only: called before saving a part when the run has already
	 * saved one, resolving once the user has clicked to save it. Chrome lets
	 * a page start one download without a click and holds back or blocks the
	 * rest, so each later part needs its own click; until then, fetching
	 * waits, so at most one full part sits in memory. Without it, parts are
	 * saved straight away.
	 */
	confirmPart?: (n: number) => Promise<void>;
}

// Modest concurrency. The export endpoint is comfortable with parallel
// requests from a logged-in browser session; 3 in flight is a sane balance
// between throughput and politeness.
const CONCURRENCY = 3;

/**
 * Fetch every activity's export with {@link CONCURRENCY} requests in flight,
 * handing each successful response to `onResponse` (with the activity's input
 * index, so callers can keep input order). Emits 'downloading' progress before
 * the first fetch and after each one settles.
 *
 * A 429 pauses the whole pool, then retries that activity (see
 * {@link fetchThrottled}) before recording it as failed.
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
	const throttle: Throttle = { resumeAt: 0 };

	onProgress?.({ stage: 'downloading', completed, total });
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (cursor < total && !signal?.aborted) {
				const i = cursor++;
				const a = activities[i]!;
				try {
					const res = await fetchThrottled(a.id, format, throttle, signal, onProgress);
					const problem = exportProblem(res, format);
					if (problem) {
						failed.push({ id: a.id, reason: problem });
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
				const pausedFor = Math.ceil((throttle.resumeAt - Date.now()) / 1000);
				onProgress?.(
					pausedFor > 0 ? { stage: 'throttled', seconds: pausedFor } : { stage: 'downloading', completed, total },
				);
			}
		}),
	);
	signal?.throwIfAborted();
	return failed;
}

/** The error of a run in which nothing could be saved. */
function allFailed(total: number, failed: BulkFailure[]): Error {
	return new Error(t('allFailed', [String(total), failed[0]?.reason ?? '?']));
}

/** Name of the activity summary added to every multi-file zip. */
const CSV_NAME = 'activities.csv';

/**
 * Bulk download. One id → one file (no zip). Multiple ids → zip, with an
 * `activities.csv` summary of that zip's files next to them. With
 * `options.splitBytes`, several zips (`…_part1.zip`, `…_part2.zip`, …), each
 * saved as soon as it's full - from the second on, once the user clicks
 * (`options.confirmPart`). File names are unique across all of a run's
 * zips, since a backup's parts are usually extracted into one folder.
 *
 * Emits progress as a discriminated event:
 *   - { stage: "downloading", completed, total } - fires immediately and after
 *     every fetch finishes (success or fail), so the caller can keep a counter
 *     in sync.
 *   - { stage: "throttled", seconds } - Strava rate-limited us; see {@link fetchAll}.
 *   - { stage: "zipping" } - fires when a zip is closed and about to be saved.
 *
 * Resolves with the count of activities saved, a list of per-activity
 * failures (including those of a zip part that couldn't be saved) and the
 * number of zips saved. Throws if nothing was saved, or if `signal` aborts -
 * zip parts saved before that stay saved (see `options.onSaved`).
 */
export async function downloadBulk(
	activities: ActivityRow[],
	format: ExportFormat,
	options: BulkOptions = {},
): Promise<BulkResult> {
	const { onProgress, signal, names = 'id', trimRadius = 0, splitBytes = 0, onSaved, confirmPart } = options;
	if (activities.length === 0) return { ok: 0, failed: [], parts: 0 };
	if (activities.length === 1) {
		await downloadSingle(activities[0]!, format, names, trimRadius, onProgress);
		onSaved?.([activities[0]!.id]);
		return { ok: 1, failed: [], parts: 1 };
	}

	// Zip filename mentions the format, so a user with several batches doesn't
	// confuse strava_gpx_…zip with strava_tcx_…zip in their Downloads folder.
	// One date per run, so the parts of a run that crosses midnight match.
	const date = today();
	const zipName = (n: number | null): string => `strava_${format}_${date}${n ? `_part${n}` : ''}.zip`;
	// Paths taken in any of the run's zips, lower-cased (see uniquePath).
	// The summary's name is reserved so no activity file can overwrite it.
	const used = new Set<string>([CSV_NAME]);
	let part = new ZipPart();
	/** Parts numbered so far: a part's number is fixed when it's set aside. */
	let numbered = 0;
	let saved = 0;
	let ok = 0;
	/** Activities in zip parts that couldn't be saved. */
	const lost: BulkFailure[] = [];
	/** Set-aside parts being saved, one at a time. */
	let saving: Promise<void> = Promise.resolve();

	/**
	 * Close and save one zip - part `n`, or the run's only zip when null.
	 * A part that fails for any reason but Cancel (running out of memory,
	 * say) is lost on its own: its activities become failures. The only
	 * zip's failure fails the run.
	 */
	async function saveZip(full: ZipPart, n: number | null): Promise<void> {
		try {
			onProgress?.({ stage: 'zipping' });
			const csv = activitiesCsv(
				activities.filter((a) => full.files.has(a.id)),
				full.files,
			);
			full.add(CSV_NAME, new TextEncoder().encode(csv));
			const blob = full.finish();
			signal?.throwIfAborted();
			if (saved > 0 && n !== null) {
				await confirmPart?.(n);
				signal?.throwIfAborted();
			}
			downloadBlob(zipName(n), blob);
			saved++;
			onSaved?.([...full.files.keys()]);
		} catch (e) {
			if (signal?.aborted || n === null) throw e;
			const reason = e instanceof Error ? e.message : String(e);
			for (const id of full.files.keys()) lost.push({ id, reason });
			ok -= full.files.size;
		}
	}

	/** Number a full part and queue it for saving. */
	function setAside(full: ZipPart): Promise<void> {
		const n = ++numbered;
		saving = saving.then(() => saveZip(full, n));
		return saving;
	}

	const failed = await fetchAll(activities, format, options, async (a, res) => {
		// A track trimmed down to nothing throws here, which records this
		// activity as failed with that reason.
		const file = await exportFile(a, res, format, names, trimRadius);
		// While a full part is being saved - or waits for its click - hold
		// on, so at most one full part sits in memory.
		await saving;
		// Full: set this zip aside and start the next one.
		if (splitBytes > 0 && part.files.size > 0 && part.bytes + file.data.byteLength > splitBytes) {
			const full = part;
			part = new ZipPart();
			await setAside(full);
		}
		// Two uploads that share a filename must not end up as one entry.
		// No `await` from here on: the part can't be closed under this file.
		part.addActivity(a.id, uniquePath(file.path, used), file.data);
		ok++;
	});

	await saving;
	if (part.files.size > 0) {
		if (numbered > 0) await setAside(part);
		else await saveZip(part, null);
	}
	const everyFailure = [...failed, ...lost];
	if (saved === 0) throw allFailed(activities.length, everyFailure);
	return { ok, failed: everyFailure, parts: saved };
}

/** Record folder exports in batches of this many, so history isn't rewritten per file. */
const FOLDER_SAVED_BATCH = 25;

/**
 * Folder backup: fetch every selected activity's export and write each file
 * straight into `dir` (a folder the user picked) as it arrives, then a
 * `strava_activities_<date>.csv` listing what was written. Nothing is zipped
 * and nothing accumulates in memory, so it suits backups of any size; with
 * the Sport folders naming, real subfolders are created.
 *
 * A file already in the folder under the same name is replaced when it has
 * the same size (the same activity, exported before); otherwise the new file
 * gets a `-2`, `-3`, … suffix, so two different activities never overwrite
 * each other across runs.
 *
 * Resolves like {@link downloadBulk}, with `parts` 0. Throws if nothing was
 * written, or if `signal` aborts - files written before that stay, and
 * `options.onSaved` has heard about them.
 */
export async function downloadToFolder(
	activities: ActivityRow[],
	format: ExportFormat,
	dir: FileSystemDirectoryHandle,
	options: BulkOptions = {},
): Promise<BulkResult> {
	const { names = 'id', trimRadius = 0, onSaved } = options;
	if (activities.length === 0) return { ok: 0, failed: [], parts: 0 };

	const used = new Set<string>();
	const files = new Map<string, string>();
	let unreported: string[] = [];
	const report = (): void => {
		if (unreported.length > 0) onSaved?.(unreported);
		unreported = [];
	};

	let failed: BulkFailure[];
	try {
		failed = await fetchAll(activities, format, options, async (a, res) => {
			const file = await exportFile(a, res, format, names, trimRadius);
			let path = uniquePath(file.path, used);
			for (let size = await existingSize(dir, path); size !== null && size !== file.data.byteLength;) {
				path = uniquePath(file.path, used);
				size = await existingSize(dir, path);
			}
			await writeFile(dir, path, file.data);
			files.set(a.id, path);
			unreported.push(a.id);
			if (unreported.length >= FOLDER_SAVED_BATCH) report();
		});
	} finally {
		// Also on Cancel: what's in the folder counts as exported.
		report();
	}
	if (files.size === 0) throw allFailed(activities.length, failed);

	const csv = activitiesCsv(
		activities.filter((a) => files.has(a.id)),
		files,
	);
	await writeFile(dir, `strava_activities_${today()}.csv`, csv);
	return { ok: files.size, failed, parts: 0 };
}

/**
 * Merge mode. Fetches every selected activity's export in `format`, parses
 * each one, and emits one combined file, in chronological order (see
 * merge.ts):
 *   - GPX, 'tracks' → one `<trk>` per activity (`strava_merged_<date>.gpx`):
 *     a multi-day trip as one track collection a mapping tool renders in one go.
 *   - GPX, 'single' → one `<trk>` with a segment per activity
 *     (`strava_joined_<date>.gpx`): to upload back to Strava as one activity.
 *   - GPX, 'geojson' → a FeatureCollection with a line per activity
 *     (`strava_merged_<date>.geojson`): for web maps and GIS tools.
 *   - TCX → one activity with a lap per activity (`strava_merged_<date>.tcx`).
 *
 * With `options.trimRadius` every source is trimmed before merging and the
 * file name gets a `_trimmed` suffix. (A trimmed TCX merge keeps the note of
 * its earliest source, whose `<Activity>` it is built on.)
 *
 * Progress events mirror {@link downloadBulk} but the post-fetch stage is
 * `'merging'` instead of `'zipping'` so the UI can show the right string.
 *
 * Resolves with the count of activities that contributed to the merged file
 * and a list of per-activity failures. Throws if *every* fetch failed, if
 * activities being joined into one overlap in time, or if `options.signal`
 * aborts.
 */
export async function downloadMerged(
	activities: ActivityRow[],
	format: 'gpx' | 'tcx',
	mode: MergeMode,
	options: BulkOptions = {},
): Promise<BulkResult> {
	if (activities.length === 0) return { ok: 0, failed: [], parts: 0 };

	// Indexed by input position rather than pushed as fetches finish, so the
	// merge never depends on which response happened to arrive first.
	const fetched: (MergeSource | undefined)[] = [];
	const trimRadius = options.trimRadius ?? 0;
	const failed = await fetchAll(activities, format, options, async (a, res, i) => {
		const xml = await res.text();
		fetched[i] = { id: a.id, name: a.name, xml: trimRadius > 0 ? trimExport(xml, format, trimRadius) : xml };
	});
	const sources = fetched.filter((s): s is MergeSource => s !== undefined);
	if (sources.length === 0) throw allFailed(activities.length, failed);

	options.onProgress?.({ stage: 'merging' });
	const suffix = trimRadius > 0 ? '_trimmed' : '';
	let merged: string;
	let name: string;
	let type = xmlType(format);
	if (format === 'tcx') {
		merged = mergeTcxDocuments(sources);
		name = `strava_merged_${today()}${suffix}.tcx`;
	} else if (mode === 'geojson') {
		merged = mergeGeoJson(sources, trimRadius);
		name = `strava_merged_${today()}${suffix}.geojson`;
		type = 'application/geo+json';
	} else {
		merged = mergeGpxDocuments(sources, mode, trimRadius);
		name = `strava_${mode === 'single' ? 'joined' : 'merged'}_${today()}${suffix}.gpx`;
	}
	options.signal?.throwIfAborted();
	downloadBlob(name, new Blob([merged], { type }));
	return { ok: sources.length, failed, parts: 1 };
}
