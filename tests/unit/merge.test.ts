// Unit tests for merging exports into one file (merge.ts): time order,
// schema order, joining, TCX laps and distances, and GeoJSON.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gpx, parseXml, tcx } from './helpers/dom.ts';
import { mergeGeoJson, mergeGpxDocuments, mergeTcxDocuments, type MergeSource } from '../../src/merge.ts';

const day1 = '2026-05-06T07:00:00.000Z';
const day2 = '2026-05-08T07:00:00.000Z';
const day3 = '2026-05-09T07:00:00.000Z';

function source(id: string, xml: string, name = `Activity ${id}`): MergeSource {
	return { id, name, xml };
}

/** Three one-track activities, listed newest first as Strava's table does. */
function threeDays(): MergeSource[] {
	return [
		source(
			'3',
			gpx('third', day3, [
				[45.2, 13.2],
				[45.21, 13.21],
			]),
		),
		source(
			'2',
			gpx('second', day2, [
				[45.1, 13.1],
				[45.11, 13.11],
			]),
		),
		source(
			'1',
			gpx('first', day1, [
				[45.0, 13.0],
				[45.01, 13.01],
			]),
		),
	];
}

function trackNames(doc: Document): string[] {
	return Array.from(doc.getElementsByTagName('trk')).map(
		(trk) => trk.getElementsByTagName('name')[0]?.textContent ?? '',
	);
}

void test('separate tracks come out in time order, whatever order they went in', () => {
	const doc = parseXml(mergeGpxDocuments(threeDays(), 'tracks', 0));
	assert.deepEqual(trackNames(doc), ['first', 'second', 'third']);
	assert.equal(doc.documentElement.getAttribute('creator'), 'Strava Bulk GPX Export');
});

void test('waypoints of every source precede every track, as GPX 1.1 requires', () => {
	const withWaypoint = gpx('late', day2, [[45.1, 13.1]], '<wpt lat="45.5" lon="13.5"><name>hut</name></wpt>');
	const doc = parseXml(mergeGpxDocuments([source('2', withWaypoint), ...threeDays().slice(2)], 'tracks', 0));
	const order = Array.from(doc.documentElement.children).map((el) => el.localName);
	assert.deepEqual(order, ['wpt', 'trk', 'trk']);
});

void test('a track without a name is named after its activity', () => {
	const unnamed = gpx('x', day1, [[45, 13]]).replace('<name>x</name>', '');
	const doc = parseXml(mergeGpxDocuments([source('1', unnamed, 'Morning Run')], 'tracks', 0));
	assert.deepEqual(trackNames(doc), ['Morning Run']);
});

void test('a malformed source is left out rather than corrupting the file', () => {
	const doc = parseXml(mergeGpxDocuments([source('9', '<gpx><trk>'), ...threeDays()], 'tracks', 0));
	assert.equal(doc.getElementsByTagName('trk').length, 3);
});

void test('"one activity" makes a single track with a segment per activity, keeping the sport', () => {
	const doc = parseXml(mergeGpxDocuments(threeDays(), 'single', 0));
	const tracks = doc.getElementsByTagName('trk');
	assert.equal(tracks.length, 1);
	assert.deepEqual(trackNames(doc), ['first']);
	assert.equal(tracks[0]!.getElementsByTagName('type')[0]?.textContent, 'running');
	const firstLat = Array.from(doc.getElementsByTagName('trkseg')).map((seg) =>
		seg.getElementsByTagName('trkpt')[0]?.getAttribute('lat'),
	);
	assert.deepEqual(firstLat, ['45', '45.1', '45.2']);
});

void test('joining refuses activities that overlap in time, naming them', () => {
	const points: [number, number][] = [
		[45, 13],
		[45.01, 13.01],
		[45.02, 13.02],
	];
	const overlapping = [
		source('1', gpx('a', '2026-05-06T07:00:00.000Z', points), 'Morning Run'),
		source('2', gpx('b', '2026-05-06T07:01:00.000Z', points), 'Morning Run (watch)'),
	];
	assert.throws(() => mergeGpxDocuments(overlapping, 'single', 0), /Morning Run and Morning Run \(watch\)/);
	// Separate tracks may overlap: nothing is interleaved.
	assert.equal(parseXml(mergeGpxDocuments(overlapping, 'tracks', 0)).getElementsByTagName('trk').length, 2);
});

void test('a merge of trimmed sources says so in its metadata', () => {
	const doc = parseXml(mergeGpxDocuments(threeDays(), 'tracks', 500));
	assert.match(doc.getElementsByTagName('desc')[0]?.textContent ?? '', /Start and end hidden \(500 m\)/);
	assert.equal(parseXml(mergeGpxDocuments(threeDays(), 'tracks', 0)).getElementsByTagName('desc').length, 0);
});

void test('a TCX merge is one activity of every lap, with distances carrying on', () => {
	const merged = mergeTcxDocuments([
		source('2', tcx('Running', day2, [0, 400, 1000])),
		source('1', tcx('Running', day1, [0, 500, 2000])),
	]);
	const doc = parseXml(merged);
	assert.equal(doc.getElementsByTagName('Activity').length, 1);
	assert.equal(doc.getElementsByTagName('Id')[0]?.textContent, day1);
	const laps = Array.from(doc.getElementsByTagName('Lap'));
	assert.deepEqual(
		laps.map((lap) => lap.getAttribute('StartTime')),
		[day1, day2],
	);
	const trackpointDistances = Array.from(doc.getElementsByTagName('Trackpoint')).map(
		(tp) => tp.getElementsByTagName('DistanceMeters')[0]?.textContent,
	);
	assert.deepEqual(trackpointDistances, ['0', '500', '2000', '2000', '2400', '3000']);
	// Lap totals are per lap and stay as they were.
	assert.deepEqual(
		laps.map((lap) => Array.from(lap.children).find((el) => el.localName === 'DistanceMeters')?.textContent),
		['2000', '1000'],
	);
	assert.equal(doc.getElementsByTagName('Activity')[0]?.getAttribute('Sport'), 'Running');
});

void test('a TCX merge of mixed sports is "Other", and unreadable input is an error', () => {
	const merged = mergeTcxDocuments([
		source('1', tcx('Running', day1, [0, 10])),
		source('2', tcx('Biking', day2, [0, 10])),
	]);
	assert.equal(parseXml(merged).getElementsByTagName('Activity')[0]?.getAttribute('Sport'), 'Other');
	assert.throws(() => mergeTcxDocuments([source('1', '<nope/>')]), /None of the TCX files could be read/);
});

interface Feature {
	properties: { id: string; name: string; sport: string | null; time: string | null; url: string };
	geometry: { type: string; coordinates: unknown };
}

void test('GeoJSON has a feature per activity in time order, as lon/lat/elevation lines', () => {
	const collection = JSON.parse(mergeGeoJson(threeDays(), 0)) as {
		type: string;
		description?: string;
		features: Feature[];
	};
	assert.equal(collection.type, 'FeatureCollection');
	assert.equal(collection.description, undefined);
	assert.deepEqual(
		collection.features.map((f) => f.properties.name),
		['first', 'second', 'third'],
	);
	const first = collection.features[0]!;
	assert.deepEqual(first.properties, {
		id: '1',
		name: 'first',
		sport: 'running',
		time: day1,
		url: 'https://www.strava.com/activities/1',
	});
	assert.deepEqual(first.geometry, {
		type: 'LineString',
		coordinates: [
			[13, 45, 100],
			[13.01, 45.01, 101],
		],
	});
});

void test('GeoJSON: several segments make a MultiLineString, and a lone point is no line', () => {
	const twoSegments = gpx('split', day1, [
		[45, 13],
		[45.01, 13.01],
	]).replace(
		'</trkseg>',
		'</trkseg><trkseg><trkpt lat="45.5" lon="13.5"/><trkpt lat="45.6" lon="13.6"/></trkseg><trkseg><trkpt lat="46" lon="14"/></trkseg>',
	);
	const lonePoint = gpx('dot', day2, [[45, 13]]);
	const collection = JSON.parse(mergeGeoJson([source('1', twoSegments), source('2', lonePoint)], 200)) as {
		description?: string;
		features: Feature[];
	};
	assert.equal(collection.features.length, 1);
	assert.equal(collection.features[0]!.geometry.type, 'MultiLineString');
	assert.equal((collection.features[0]!.geometry.coordinates as unknown[]).length, 2);
	assert.match(collection.description ?? '', /Start and end hidden \(200 m\)/);
	assert.throws(() => mergeGeoJson([source('2', lonePoint)], 0), /None of the activities has a track/);
});
