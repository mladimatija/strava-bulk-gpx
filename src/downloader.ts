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
import type { ActivityRow, BulkResult, ExportFormat, ProgressCallback } from './types.ts';

/** Build the URL for a given activity + format. */
function exportUrl(id: string, format: ExportFormat): string {
	return `/activities/${id}/export_${format}`;
}

/**
 * Construct the filename we want the file saved as. For GPX/TCX we know the
 * extension up-front (`strava_<id>.gpx` / `.tcx`). For "original" the extension
 * depends on what the user originally uploaded - we'd have to inspect Strava's
 * Content-Disposition header - so we return null and let the browser respect
 * whatever filename the server suggests.
 */
function suggestedFilename(id: string, format: ExportFormat): string | null {
	if (format === 'original') return null;
	return `strava_${id}.${format}`;
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

/**
 * Per-row download. Fires a same-origin anchor click - Strava streams the file
 * via the browser's download manager. Returns a resolved promise so callers
 * can `await` without `require-await` complaints; the browser handles the
 * actual writing out of band.
 */
export function downloadSingle(activity: ActivityRow, format: ExportFormat): Promise<void> {
	const id = String(activity.id);
	downloadViaAnchor(exportUrl(id, format), suggestedFilename(id, format));
	return Promise.resolve();
}

/** Backwards-compatible alias - older callers passed no format and expected GPX. */
export function downloadSingleGpx(activity: ActivityRow): Promise<void> {
	return downloadSingle(activity, 'gpx');
}

export interface BulkOptions {
	/**
	 * Notified as the download progresses through its stages. See {@link ProgressEvent}.
	 */
	onProgress?: ProgressCallback;
}

/**
 * Bulk download. One id → one file (no zip). Multiple ids → zip.
 *
 * Emits progress as a discriminated event:
 *   - { stage: "downloading", completed, total } - fires immediately and after
 *     every fetch finishes (success or fail), so the caller can keep a counter
 *     in sync.
 *   - { stage: "zipping" } - fires once when fetches are done and JSZip starts
 *     assembling. Useful for keeping a spinner alive during what can be a
 *     multi-second client-side step on large batches.
 *
 * Resolves with the count of successes and a list of per-activity failures.
 * Throws only if *every* activity failed.
 */
export async function downloadBulk(
	activities: ActivityRow[],
	format: ExportFormat,
	{ onProgress }: BulkOptions = {},
): Promise<BulkResult> {
	if (activities.length === 0) return { ok: 0, failed: [] };
	if (activities.length === 1) {
		await downloadSingle(activities[0]!, format);
		return { ok: 1, failed: [] };
	}

	const total = activities.length;
	const zip = new JSZip();
	const failed: BulkResult['failed'] = [];
	let completed = 0;

	onProgress?.({ stage: 'downloading', completed, total });

	// Modest concurrency. The export endpoint is comfortable with parallel
	// requests from a logged-in browser session; 3 in flight is a sane balance
	// between throughput and politeness.
	const concurrency = 3;
	let cursor = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (cursor < total) {
				const i = cursor++;
				const a = activities[i]!;
				try {
					const res = await fetch(exportUrl(a.id, format), {
						method: 'GET',
						credentials: 'same-origin',
					});
					if (!res.ok) {
						failed.push({ id: a.id, reason: `HTTP ${res.status}` });
					} else {
						const blob = await res.blob();
						// GPX/TCX: known extension, deterministic name.
						// Original: trust the server's filename (typically
						// includes the original file extension); fall back to
						// strava_<id> with no extension if it's missing.
						let entryName: string;
						if (format === 'original') {
							const fromHeader = parseContentDispositionFilename(res.headers.get('content-disposition'));
							entryName = fromHeader ? sanitizeFilename(fromHeader) : `strava_${a.id}`;
						} else {
							entryName = `strava_${a.id}.${format}`;
						}
						zip.file(entryName, blob);
					}
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					failed.push({ id: a.id, reason: message });
				}
				completed++;
				onProgress?.({ stage: 'downloading', completed, total });
			}
		}),
	);

	const successCount = total - failed.length;
	if (successCount === 0) {
		throw new Error(`All ${total} downloads failed. First error: ${failed[0]?.reason ?? 'unknown'}`);
	}

	onProgress?.({ stage: 'zipping' });
	const blob = await zip.generateAsync({
		type: 'blob',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
	});
	const date = new Date().toISOString().slice(0, 10);
	// Zip filename mentions the format, so a user with several batches doesn't
	// confuse strava_gpx_…zip with strava_tcx_…zip in their Downloads folder.
	downloadBlob(`strava_${format}_${date}.zip`, blob);
	return { ok: successCount, failed };
}

/** Backwards-compatible alias - older callers passed no format and expected GPX. */
export function downloadBulkGpx(activities: ActivityRow[], options: BulkOptions = {}): Promise<BulkResult> {
	return downloadBulk(activities, 'gpx', options);
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

/**
 * Assemble a single GPX 1.1 document by concatenating the `<wpt>`, `<rte>`,
 * and `<trk>` children of every source GPX. The output preserves namespaces,
 * including any Strava-specific extensions on track points (heart rate,
 * cadence, etc.) - `importNode(node, true)` copies the whole subtree without
 * stripping anything.
 *
 * If a source `<trk>` has no `<name>` child, we inject one using the activity
 * title, so the merged file is still readable in tools like Garmin BaseCamp
 * that list tracks by name.
 */
function mergeGpxDocuments(sources: { id: string; name: string; xml: string }[]): string {
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

	for (const src of sources) {
		const doc = parser.parseFromString(src.xml, 'application/xml');
		// DOMParser returns an error document with a <parsererror> root rather
		// than throwing on malformed XML. Skip those - the activity will still
		// be counted as a successful fetch upstream, but its content can't be
		// merged. (Better than corrupting the whole output.)
		if (doc.getElementsByTagName('parsererror').length > 0) continue;

		// Order matters per the GPX schema: <wpt>* then <rte>* then <trk>*.
		// Strava's exports are pure <trk> in practice, but we honour the order
		// for any source that does carry waypoints or routes.
		for (const wpt of Array.from(doc.getElementsByTagName('wpt'))) {
			root.appendChild(outDoc.importNode(wpt, true));
		}
		for (const rte of Array.from(doc.getElementsByTagName('rte'))) {
			root.appendChild(outDoc.importNode(rte, true));
		}
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
 * with N `<trk>` children - useful for stitching together a multi-day trip
 * into a single track collection a mapping tool can render in one go.
 *
 * Progress events mirror {@link downloadBulk} but the post-fetch stage is
 * `'merging'` instead of `'zipping'` so the UI can show the right string.
 *
 * Resolves with the count of activities that contributed to the merged file
 * and a list of per-activity failures. Throws only if *every* fetch failed.
 */
export async function downloadMergedGpx(
	activities: ActivityRow[],
	{ onProgress }: BulkOptions = {},
): Promise<BulkResult> {
	if (activities.length === 0) return { ok: 0, failed: [] };

	const total = activities.length;
	const failed: BulkResult['failed'] = [];
	const fetched: { id: string; name: string; xml: string }[] = [];
	let completed = 0;

	onProgress?.({ stage: 'downloading', completed, total });

	// Same concurrency profile as the bulk-zip path - Strava handles three
	// in-flight requests from a logged-in session comfortably.
	const concurrency = 3;
	let cursor = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (cursor < total) {
				const i = cursor++;
				const a = activities[i]!;
				try {
					const res = await fetch(exportUrl(a.id, 'gpx'), {
						method: 'GET',
						credentials: 'same-origin',
					});
					if (!res.ok) {
						failed.push({ id: a.id, reason: `HTTP ${res.status}` });
					} else {
						fetched.push({ id: a.id, name: a.name, xml: await res.text() });
					}
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					failed.push({ id: a.id, reason: message });
				}
				completed++;
				onProgress?.({ stage: 'downloading', completed, total });
			}
		}),
	);

	if (fetched.length === 0) {
		throw new Error(`All ${total} downloads failed. First error: ${failed[0]?.reason ?? 'unknown'}`);
	}

	onProgress?.({ stage: 'merging' });
	const merged = mergeGpxDocuments(fetched);
	const blob = new Blob([merged], { type: 'application/gpx+xml' });
	const date = new Date().toISOString().slice(0, 10);
	downloadBlob(`strava_merged_${date}.gpx`, blob);
	return { ok: fetched.length, failed };
}
