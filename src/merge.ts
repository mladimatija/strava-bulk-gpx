// Combining several activities' exports into one file: a GPX track
// collection, one joined GPX activity, one TCX activity, or a GeoJSON
// feature collection. Pure text in, text out - fetching and saving live in
// downloader.ts - so it runs under `node --test` with a DOM shim.

import { t } from './i18n.ts';
import { markTrimmed, trimNote } from './trim.ts';
import { childrenNamed, GPX_NS, serializeXml, TCX_NS } from './xml.ts';

export interface MergeSource {
	id: string;
	name: string;
	xml: string;
}

/** A parsed merge source and its time span (ms since the epoch; NaN when unknown). */
interface ParsedSource {
	src: MergeSource;
	doc: Document;
	start: number;
	end: number;
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

/** When a GPX document ends: its last track point's `<time>`, or NaN. */
function gpxEndTime(doc: Document): number {
	const points = doc.getElementsByTagName('trkpt');
	const time = points[points.length - 1]?.getElementsByTagName('time')[0];
	return Date.parse(time?.textContent ?? '');
}

/**
 * Parse every source and order them by start time, so a multi-day trip reads
 * day 1 → day N whatever order the rows were listed or fetched in. Sources
 * without a start time keep their relative order, after the timed ones.
 *
 * DOMParser returns an error document with a <parsererror> root rather than
 * throwing on malformed XML. Those sources are skipped - the activity still
 * counts as a successful fetch upstream, but its content can't be merged.
 * (Better than corrupting the whole output.)
 */
function parseSources(sources: MergeSource[], span: (doc: Document) => [number, number]): ParsedSource[] {
	const parser = new DOMParser();
	return sources
		.map((src) => {
			const doc = parser.parseFromString(src.xml, 'application/xml');
			const [start, end] = span(doc);
			return { src, doc, start, end };
		})
		.filter(({ doc }) => doc.getElementsByTagName('parsererror').length === 0)
		.sort((a, b) => {
			const aUntimed = Number.isNaN(a.start);
			const bUntimed = Number.isNaN(b.start);
			if (aUntimed || bUntimed) return Number(aUntimed) - Number(bUntimed);
			return a.start - b.start;
		});
}

/**
 * Joining activities into one only makes sense when they follow each other.
 * If one starts before the previous one ends (say, two devices recorded the
 * same ride), interleaving their points would zigzag - so refuse, naming the
 * first overlapping pair.
 */
function assertNoOverlap(parsed: ParsedSource[]): void {
	for (let i = 1; i < parsed.length; i++) {
		const prev = parsed[i - 1]!;
		const cur = parsed[i]!;
		if (cur.start < prev.end) throw new Error(t('mergeOverlap', [prev.src.name, cur.src.name]));
	}
}

/**
 * One `<trk>` holding every source's `<trkseg>`s in time order. GPX defines a
 * new segment as "the receiver was turned off", so this reads as one journey
 * with gaps - the shape needed to upload several activities back to Strava
 * as a single one. Named after the first activity and keeps its `<type>`
 * (the sport), which must precede the segments.
 */
function joinTracks(outDoc: Document, parsed: ParsedSource[]): Element {
	const trk = outDoc.createElementNS(GPX_NS, 'trk');
	const first = parsed[0];
	const firstTrk = first?.doc.getElementsByTagName('trk')[0];
	const nameEl = outDoc.createElementNS(GPX_NS, 'name');
	nameEl.textContent = (firstTrk && childrenNamed(firstTrk, 'name')[0]?.textContent) ?? first?.src.name ?? '';
	trk.appendChild(nameEl);
	const type = firstTrk && childrenNamed(firstTrk, 'type')[0];
	if (type) trk.appendChild(outDoc.importNode(type, true));
	for (const { doc } of parsed) {
		for (const seg of Array.from(doc.getElementsByTagName('trkseg'))) {
			trk.appendChild(outDoc.importNode(seg, true));
		}
	}
	return trk;
}

/**
 * Assemble a single GPX 1.1 document from the `<wpt>`, `<rte>`, and `<trk>`
 * content of every source GPX, in chronological order. The output preserves
 * namespaces, including any Strava-specific extensions on track points (heart
 * rate, cadence, etc.) - `importNode(node, true)` copies the whole subtree
 * without stripping anything.
 *
 * `mode` decides what happens to the tracks: 'tracks' keeps one `<trk>` per
 * activity; 'single' joins them into one (see {@link joinTracks}) and refuses
 * overlapping activities. A `trimRadius` > 0 means the sources were trimmed;
 * the merged file then carries the same note in its metadata.
 *
 * If a source `<trk>` has no `<name>` child, we inject one using the activity
 * title, so the merged file is still readable in tools like Garmin BaseCamp
 * that list tracks by name.
 */
export function mergeGpxDocuments(sources: MergeSource[], mode: 'tracks' | 'single', trimRadius: number): string {
	const parser = new DOMParser();

	const outDoc = parser.parseFromString(
		`<?xml version="1.0" encoding="UTF-8"?>` +
			`<gpx version="1.1" creator="Strava Bulk GPX Export" ` +
			`xmlns="${GPX_NS}" ` +
			`xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
			`xsi:schemaLocation="${GPX_NS} http://www.topografix.com/GPX/1/1/gpx.xsd"/>`,
		'application/xml',
	);
	const root = outDoc.documentElement;

	const parsed = parseSources(sources, (doc) => [gpxStartTime(doc), gpxEndTime(doc)]);
	if (mode === 'single') assertNoOverlap(parsed);

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
	if (mode === 'single') {
		root.appendChild(joinTracks(outDoc, parsed));
	} else {
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
	}

	if (trimRadius > 0) markTrimmed(outDoc, trimRadius);
	return serializeXml(outDoc);
}

/** A TCX document's (first) activity. */
function tcxActivity(doc: Document): Element | undefined {
	return doc.getElementsByTagNameNS(TCX_NS, 'Activity')[0];
}

/** When a TCX activity starts (its `<Id>`) and ends (its last trackpoint `<Time>`). */
function tcxSpan(doc: Document): [number, number] {
	const activity = tcxActivity(doc);
	const id = activity && childrenNamed(activity, 'Id')[0];
	const times = doc.getElementsByTagNameNS(TCX_NS, 'Time');
	return [Date.parse(id?.textContent ?? ''), Date.parse(times[times.length - 1]?.textContent ?? '')];
}

/** The cumulative `<DistanceMeters>` of every trackpoint under `scope` (lap totals excluded). */
function trackpointDistances(scope: Element): Element[] {
	return Array.from(scope.getElementsByTagNameNS(TCX_NS, 'Trackpoint')).flatMap((tp) =>
		childrenNamed(tp, 'DistanceMeters'),
	);
}

/** The largest trackpoint distance under `scope` - how far that activity went. */
function distanceCovered(scope: Element): number {
	return trackpointDistances(scope).reduce((max, el) => Math.max(max, Number(el.textContent) || 0), 0);
}

/**
 * Merge TCX files into one activity whose laps are every source's laps, in
 * time order - the TCX counterpart of joining GPX tracks. (Several
 * `<Activity>` elements in one file would be schema-valid too, but Strava
 * treats a TCX upload as a single activity and Garmin Connect doesn't import
 * them reliably.)
 *
 * The earliest source is the base document, so its root namespaces, `<Id>`
 * and `<Creator>` carry over. Trackpoint distances are cumulative within an
 * activity, so each later source's are offset by the distance covered before
 * it; lap totals are per lap and stay as they are. Mixed sports become
 * "Other". Overlapping activities are refused, as for joined GPX.
 */
export function mergeTcxDocuments(sources: MergeSource[]): string {
	const parsed = parseSources(sources, tcxSpan).filter(({ doc }) => {
		const activity = tcxActivity(doc);
		return activity !== undefined && childrenNamed(activity, 'Id').length > 0;
	});
	assertNoOverlap(parsed);
	const [base, ...rest] = parsed;
	if (!base) throw new Error(t('tcxUnreadable'));

	const activity = tcxActivity(base.doc)!;
	const sports = new Set(parsed.map(({ doc }) => tcxActivity(doc)!.getAttribute('Sport')));
	if (sports.size > 1) activity.setAttribute('Sport', 'Other');

	// New laps go after the base activity's last lap (or its <Id>), before
	// any <Notes>/<Creator> - the schema's order inside <Activity>.
	let last = childrenNamed(activity, 'Lap').at(-1) ?? childrenNamed(activity, 'Id')[0]!;
	let covered = distanceCovered(activity);
	for (const { doc } of rest) {
		const source = tcxActivity(doc)!;
		const offset = covered;
		for (const lap of childrenNamed(source, 'Lap')) {
			const imported = base.doc.importNode(lap, true);
			for (const el of trackpointDistances(imported)) {
				el.textContent = String(Math.round(((Number(el.textContent) || 0) + offset) * 100) / 100);
			}
			last.after(imported);
			last = imported;
		}
		covered = offset + distanceCovered(source);
	}

	return serializeXml(base.doc);
}

/** A GeoJSON position: longitude, latitude and, when known, elevation. */
type Position = [number, number] | [number, number, number];

/** A track point as a GeoJSON position, or null without usable coordinates. */
function positionOf(point: Element): Position | null {
	const lat = parseFloat(point.getAttribute('lat') ?? '');
	const lon = parseFloat(point.getAttribute('lon') ?? '');
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	const ele = parseFloat(childrenNamed(point, 'ele')[0]?.textContent ?? '');
	return Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

/**
 * Merge GPX files into one GeoJSON FeatureCollection (RFC 7946) with a
 * feature per activity, in time order - the shape web maps and GIS tools
 * load directly. Each feature is a LineString, or a MultiLineString when the
 * activity has several segments (pauses, or gaps left by Hide start/end),
 * and carries the activity's id, name, sport, start time and Strava URL.
 * Sensor data (heart rate, cadence, per-point times) is left out: GeoJSON
 * has no standard place for it.
 *
 * Activities without a line - fewer than two located points - are skipped.
 * Throws when none is left.
 */
export function mergeGeoJson(sources: MergeSource[], trimRadius: number): string {
	const parsed = parseSources(sources, (doc) => [gpxStartTime(doc), gpxEndTime(doc)]);
	const features = parsed.flatMap(({ src, doc, start }) => {
		const lines = Array.from(doc.getElementsByTagName('trkseg'))
			.map((seg) =>
				childrenNamed(seg, 'trkpt')
					.map(positionOf)
					.filter((p): p is Position => p !== null),
			)
			.filter((line) => line.length >= 2);
		if (lines.length === 0) return [];
		const trk = doc.getElementsByTagName('trk')[0];
		return [
			{
				type: 'Feature',
				properties: {
					id: src.id,
					name: (trk && childrenNamed(trk, 'name')[0]?.textContent) ?? src.name,
					sport: (trk && childrenNamed(trk, 'type')[0]?.textContent) ?? null,
					time: Number.isNaN(start) ? null : new Date(start).toISOString(),
					url: `https://www.strava.com/activities/${src.id}`,
				},
				geometry:
					lines.length === 1
						? { type: 'LineString', coordinates: lines[0] }
						: { type: 'MultiLineString', coordinates: lines },
			},
		];
	});
	if (features.length === 0) throw new Error(t('geojsonEmpty'));
	return JSON.stringify({
		type: 'FeatureCollection',
		// A foreign member, which RFC 7946 allows: says the file was trimmed.
		...(trimRadius > 0 ? { description: trimNote(trimRadius) } : {}),
		features,
	});
}
