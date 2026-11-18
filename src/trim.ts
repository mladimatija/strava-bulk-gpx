// "Hide start/end": remove the locations near where an activity starts and
// ends before saving a GPX or TCX, so a file you share doesn't show where you
// live. Strava's own map-visibility hiding applies on strava.com only -
// exports of your own activities contain every point.
//
// Opt-in, for GPX and TCX (Original files are mostly binary FIT). A trimmed
// file is no longer Strava's byte-identical export, so it says so: `_trimmed`
// in the file name (see downloader.ts) and a note in the file itself.

import { t } from './i18n.ts';
import { childrenNamed, serializeXml, TCX_NS } from './xml.ts';

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

/** The note a trimmed file carries. */
function trimNote(radiusM: number): string {
	// Whole metres: a custom distance in feet is a fraction of a metre off.
	return `Start and end hidden (${Math.round(radiusM)} m) by Strava Bulk GPX Export - not Strava's original export.`;
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
	const note = trimNote(radiusM);
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

/** A TCX trackpoint's coordinates, or null if it has none (indoor, GPS dropout). */
function tcxPointOf(trackpoint: Element): LatLon | null {
	const position = childrenNamed(trackpoint, 'Position')[0];
	if (!position) return null;
	const lat = parseFloat(childrenNamed(position, 'LatitudeDegrees')[0]?.textContent ?? '');
	const lon = parseFloat(childrenNamed(position, 'LongitudeDegrees')[0]?.textContent ?? '');
	return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * Note in the activity's `<Notes>` that the file was trimmed, creating it
 * after the last `<Lap>` where needed - the schema's order inside
 * `<Activity>` is Id, Lap…, Notes, Training, Creator.
 */
function markTcxTrimmed(doc: Document, radiusM: number): void {
	for (const activity of Array.from(doc.getElementsByTagNameNS(TCX_NS, 'Activity'))) {
		const note = trimNote(radiusM);
		const notes = childrenNamed(activity, 'Notes')[0];
		if (notes) {
			notes.textContent = `${notes.textContent ?? ''}\n${note}`.trim();
			continue;
		}
		const created = doc.createElementNS(TCX_NS, 'Notes');
		created.textContent = note;
		const anchor = childrenNamed(activity, 'Lap').at(-1) ?? childrenNamed(activity, 'Id')[0];
		if (anchor) anchor.after(created);
		else activity.appendChild(created);
	}
}

/**
 * The TCX counterpart of {@link trimGpx}: every trackpoint within `radiusM`
 * of the first or last located trackpoint loses its `<Position>`. Its time,
 * distance, heart rate, cadence and power stay - a TCX is mostly wanted for
 * that sensor data. Each `<Track>` is split where hidden and visible points
 * meet, so maps don't draw a line across the hidden area. Trackpoints that
 * never had a position stay with their neighbours.
 *
 * Throws (with a message fit for the failure list) when no located
 * trackpoint would remain.
 */
export function trimTcx(xml: string, radiusM: number): string {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Invalid TCX');
	const located = Array.from(doc.getElementsByTagNameNS(TCX_NS, 'Trackpoint'))
		.map(tcxPointOf)
		.filter((p): p is LatLon => p !== null);
	const first = located[0];
	const last = located.at(-1);
	if (!first || !last) throw new Error(t('trimAllHidden'));

	let visibleLeft = 0;
	for (const track of Array.from(doc.getElementsByTagNameNS(TCX_NS, 'Track'))) {
		// Runs of consecutive points on the same side of the cut; each run
		// becomes a <Track>.
		const runs: { hidden: boolean; points: Element[] }[] = [];
		for (const tp of childrenNamed(track, 'Trackpoint')) {
			const p = tcxPointOf(tp);
			const hidden = p !== null && (distanceM(p, first) <= radiusM || distanceM(p, last) <= radiusM);
			if (hidden) for (const position of childrenNamed(tp, 'Position')) position.remove();
			else if (p) visibleLeft++;
			const run = runs.at(-1);
			// A point without a position doesn't start a new run.
			if (run && (p === null || run.hidden === hidden)) run.points.push(tp);
			else runs.push({ hidden, points: [tp] });
		}
		let previous = track;
		for (const run of runs.slice(1)) {
			const next = doc.createElementNS(TCX_NS, 'Track');
			for (const tp of run.points) next.appendChild(tp);
			previous.after(next);
			previous = next;
		}
	}
	if (visibleLeft === 0) throw new Error(t('trimAllHidden'));

	markTcxTrimmed(doc, radiusM);
	return serializeXml(doc);
}
