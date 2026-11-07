// "Hide start/end": remove the points near where an activity starts and ends
// before saving a GPX, so a file you share doesn't show where you live.
// Strava's own map-visibility hiding applies on strava.com only - exports of
// your own activities contain every point.
//
// Opt-in and GPX-only. A trimmed file is no longer Strava's byte-identical
// export, so it says so: `_trimmed` in the file name (see downloader.ts) and
// a note in `<metadata><desc>`.

import { t } from './i18n.ts';
import { childrenNamed, serializeXml } from './xml.ts';

interface LatLon {
	lat: number;
	lon: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two points in metres (haversine). */
function distanceM(a: LatLon, b: LatLon): number {
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLon = (b.lon - a.lon) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A GPX point's coordinates, or null if it has none. */
function pointOf(el: Element): LatLon | null {
	const lat = parseFloat(el.getAttribute('lat') ?? '');
	const lon = parseFloat(el.getAttribute('lon') ?? '');
	return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * Note in `<metadata><desc>` that the file was trimmed, creating the
 * elements where needed (`<metadata>` must be the root's first child, and
 * `<desc>` follows `<name>` in it). Also drops `<bounds>`, which may describe
 * points that are gone.
 */
export function markTrimmed(doc: Document, radiusM: number): void {
	const root = doc.documentElement;
	const ns = root.namespaceURI;
	let metadata = childrenNamed(root, 'metadata')[0];
	if (!metadata) {
		metadata = doc.createElementNS(ns, 'metadata');
		root.insertBefore(metadata, root.firstElementChild);
	}
	for (const bounds of childrenNamed(metadata, 'bounds')) bounds.remove();
	const note = `Start and end hidden (${radiusM} m) by Strava Bulk GPX Export - not Strava's original export.`;
	const desc = childrenNamed(metadata, 'desc')[0];
	if (desc) {
		desc.textContent = `${desc.textContent ?? ''}\n${note}`.trim();
	} else {
		const created = doc.createElementNS(ns, 'desc');
		created.textContent = note;
		const name = childrenNamed(metadata, 'name')[0];
		metadata.insertBefore(created, name ? name.nextElementSibling : metadata.firstElementChild);
	}
}

/**
 * Remove every point within `radiusM` of the track's first or last point -
 * track points, waypoints and route points. It's a straight-line radius
 * rather than a distance along the track, so a mid-route pass close to home
 * is hidden too. Where hidden points cut a segment, what's left becomes
 * separate segments; otherwise maps would draw a straight line across the
 * hidden area, outlining it.
 *
 * Throws (with a message fit for the failure list) when no track point
 * would remain.
 */
export function trimGpx(xml: string, radiusM: number): string {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Invalid GPX');
	const trackPoints = Array.from(doc.getElementsByTagName('trkpt'));
	const first = trackPoints[0] && pointOf(trackPoints[0]);
	const last = trackPoints.at(-1) && pointOf(trackPoints.at(-1)!);
	if (!first || !last) throw new Error(t('trimAllHidden'));
	const hidden = (el: Element): boolean => {
		const p = pointOf(el);
		return p !== null && (distanceM(p, first) <= radiusM || distanceM(p, last) <= radiusM);
	};

	for (const seg of Array.from(doc.getElementsByTagName('trkseg'))) {
		// Runs of consecutive kept points; each becomes a segment.
		const runs: Element[][] = [[]];
		for (const pt of childrenNamed(seg, 'trkpt')) {
			pt.remove();
			if (!hidden(pt)) runs.at(-1)!.push(pt);
			else if (runs.at(-1)!.length > 0) runs.push([]);
		}
		const kept = runs.filter((run) => run.length > 0);
		if (kept.length === 0) {
			seg.remove();
			continue;
		}
		// The first run goes back into this segment, ahead of any
		// <extensions> (the schema puts points first); later runs get new
		// segments right after it.
		const extensions = childrenNamed(seg, 'extensions')[0] ?? null;
		for (const pt of kept[0]!) seg.insertBefore(pt, extensions);
		let previous = seg;
		for (const run of kept.slice(1)) {
			const next = doc.createElementNS(seg.namespaceURI, 'trkseg');
			for (const pt of run) next.appendChild(pt);
			previous.after(next);
			previous = next;
		}
	}
	if (doc.getElementsByTagName('trkpt').length === 0) throw new Error(t('trimAllHidden'));

	for (const tag of ['wpt', 'rtept']) {
		for (const el of Array.from(doc.getElementsByTagName(tag))) {
			if (hidden(el)) el.remove();
		}
	}
	markTrimmed(doc, radiusM);
	return serializeXml(doc);
}
