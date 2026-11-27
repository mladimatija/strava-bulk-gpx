// Unit tests for Hide start/end (trim.ts): which points go, how tracks are
// split around the hidden area, and what a trimmed file says about itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gpx, parseXml, tcx } from './helpers/dom.ts';
import { trimGpx, trimTcx } from '../../src/trim.ts';

const start = '2026-05-06T07:00:00.000Z';

// One degree of latitude is about 111 km, so 0.001° is about 111 m. An
// out-and-back that passes its start again half-way: home, away, home, away,
// and an end 2 km off.
const HOME: [number, number] = [45, 13];
const OUT_AND_BACK: [number, number][] = [
	HOME,
	[45.001, 13], // 111 m from home
	[45.01, 13], // 1.1 km
	[45.0005, 13], // 55 m: passing home again
	[45.01, 13],
	[45.019, 13], // 111 m from the end
	[45.02, 13], // the end
];

function lats(scope: Element | Document): string[] {
	return Array.from(scope.getElementsByTagName('trkpt')).map((pt) => pt.getAttribute('lat') ?? '');
}

void test('GPX: points near the start and end go, and the track splits where it passes them', () => {
	const doc = parseXml(trimGpx(gpx('run', start, OUT_AND_BACK), 200));
	assert.deepEqual(lats(doc), ['45.01', '45.01']);
	const segments = Array.from(doc.getElementsByTagName('trkseg'));
	assert.deepEqual(
		segments.map((seg) => lats(seg)),
		[['45.01'], ['45.01']],
	);
});

void test('GPX: a trimmed file notes it in its metadata and loses its bounds', () => {
	const withBounds = gpx('run', start, OUT_AND_BACK).replace(
		'<metadata>',
		'<metadata><name>Run</name><bounds minlat="45" minlon="13" maxlat="45.02" maxlon="13"/>',
	);
	const doc = parseXml(trimGpx(withBounds, 200));
	const metadata = doc.getElementsByTagName('metadata')[0]!;
	assert.equal(metadata.getElementsByTagName('bounds').length, 0);
	assert.deepEqual(
		Array.from(metadata.children).map((el) => el.localName),
		['name', 'desc', 'time'],
	);
	assert.match(metadata.getElementsByTagName('desc')[0]?.textContent ?? '', /^Start and end hidden \(200 m\)/);
});

void test('GPX: waypoints and route points inside the radius go too', () => {
	const extra = '<wpt lat="45.0001" lon="13"><name>home</name></wpt><wpt lat="45.01" lon="13"><name>cafe</name></wpt>';
	const doc = parseXml(trimGpx(gpx('run', start, OUT_AND_BACK, extra), 200));
	const names = Array.from(doc.getElementsByTagName('wpt')).map((w) => w.getElementsByTagName('name')[0]?.textContent);
	assert.deepEqual(names, ['cafe']);
});

void test('GPX: a track wholly inside the radius is an error, as is a file that is not XML', () => {
	const short = gpx('walk', start, [HOME, [45.0005, 13], [45.001, 13]]);
	assert.throws(() => trimGpx(short, 500), /the whole track is within the hidden distance/);
	assert.throws(() => trimGpx('<gpx><trk>', 200), /Strava's GPX file couldn't be read/);
});

void test('TCX: hidden trackpoints lose their position but keep their sensor data', () => {
	const distances = OUT_AND_BACK.map((_, i) => i * 100);
	const doc = parseXml(trimTcx(tcx('Running', start, distances, OUT_AND_BACK), 200));
	const trackpoints = Array.from(doc.getElementsByTagName('Trackpoint'));
	assert.equal(trackpoints.length, OUT_AND_BACK.length);
	assert.deepEqual(
		trackpoints.map((tp) => tp.getElementsByTagName('Position').length),
		[0, 0, 1, 0, 1, 0, 0],
	);
	for (const tp of trackpoints) {
		assert.equal(tp.getElementsByTagName('HeartRateBpm').length, 1);
		assert.equal(tp.getElementsByTagName('Time').length, 1);
	}
	// One <Track> per run of hidden or visible points.
	assert.equal(doc.getElementsByTagName('Track').length, 5);
	assert.match(doc.getElementsByTagName('Notes')[0]?.textContent ?? '', /Start and end hidden \(200 m\)/);
});

void test('TCX: nothing located left is an error', () => {
	assert.throws(
		() => trimTcx(tcx('Running', start, [0, 50], [HOME, [45.0002, 13]]), 500),
		/the whole track is within the hidden distance/,
	);
	assert.throws(() => trimTcx(tcx('Other', start, [0, 50]), 500), /the whole track is within the hidden distance/);
});
