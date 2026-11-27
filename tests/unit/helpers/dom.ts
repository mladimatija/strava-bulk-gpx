// A DOM for the unit tests of modules that parse and build XML (merge.ts,
// trim.ts) or read `location` (csv.ts): jsdom's DOMParser and XMLSerializer,
// installed as globals the way a content script finds them.
//
// Import this module before the module under test.

import { JSDOM } from 'jsdom';

const { window } = new JSDOM('', { url: 'https://www.strava.com/athlete/training' });

Object.assign(globalThis, {
	DOMParser: window.DOMParser,
	XMLSerializer: window.XMLSerializer,
	location: window.location,
});

/** Parse `xml`, failing the test if it isn't well-formed or has more than one XML declaration. */
export function parseXml(xml: string): Document {
	const doc = new window.DOMParser().parseFromString(xml, 'application/xml');
	const error = doc.getElementsByTagName('parsererror')[0];
	if (error) throw new Error(`Not well-formed: ${error.textContent}`);
	if ((xml.match(/<\?xml /g) ?? []).length !== 1) throw new Error('Expected exactly one XML declaration');
	return doc;
}

/** A GPX of one track, with a point per `[lat, lon]`, a minute apart from `start`. */
export function gpx(name: string, start: string, points: [number, number][], extra = ''): string {
	const t0 = Date.parse(start);
	const trkpts = points
		.map(
			([lat, lon], i) =>
				`<trkpt lat="${lat}" lon="${lon}"><ele>${100 + i}</ele><time>${new Date(t0 + i * 60_000).toISOString()}</time></trkpt>`,
		)
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava" xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>${start}</time></metadata>${extra}
  <trk><name>${name}</name><type>running</type><trkseg>${trkpts}</trkseg></trk>
</gpx>`;
}

/** A one-lap TCX activity with a trackpoint per cumulative distance, a minute apart from `start`. */
export function tcx(sport: string, start: string, distances: number[], positions: [number, number][] = []): string {
	const t0 = Date.parse(start);
	const points = distances
		.map((d, i) => {
			const p = positions[i];
			const position = p
				? `<Position><LatitudeDegrees>${p[0]}</LatitudeDegrees><LongitudeDegrees>${p[1]}</LongitudeDegrees></Position>`
				: '';
			return `<Trackpoint><Time>${new Date(t0 + i * 60_000).toISOString()}</Time>${position}<DistanceMeters>${d}</DistanceMeters><HeartRateBpm><Value>${120 + i}</Value></HeartRateBpm></Trackpoint>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="${sport}"><Id>${start}</Id><Lap StartTime="${start}"><TotalTimeSeconds>${(distances.length - 1) * 60}</TotalTimeSeconds><DistanceMeters>${distances.at(-1) ?? 0}</DistanceMeters><Track>${points}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}
