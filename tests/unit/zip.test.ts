// Unit tests for the zip writer (zip.ts): what's added is what a zip reader
// gets back, under the names given.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { ZipPart } from '../../src/zip.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

void test('files come back out byte for byte, including non-ASCII names and folders', async () => {
	const part = new ZipPart();
	const fit = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
	part.addActivity('1', 'Trail Run/1_Novi Šćapi.gpx', bytes('<gpx/>'));
	part.addActivity('2', '2_朝ラン.fit', fit);
	part.add('activities.csv', bytes('id\r\n1\r\n2\r\n'));
	const blob = part.finish();
	assert.equal(blob.type, 'application/zip');

	const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
	assert.deepEqual(Object.keys(entries).sort(), ['2_朝ラン.fit', 'Trail Run/1_Novi Šćapi.gpx', 'activities.csv']);
	assert.equal(strFromU8(entries['Trail Run/1_Novi Šćapi.gpx']!), '<gpx/>');
	assert.deepEqual(entries['2_朝ラン.fit'], fit);
});

void test('a part tracks its activities and its size before compression', () => {
	const part = new ZipPart();
	const repetitive = bytes('<trkpt lat="45" lon="13"/>'.repeat(1000));
	part.addActivity('1', 'strava_1.gpx', repetitive);
	part.addActivity('2', 'strava_2.gpx', repetitive);
	assert.deepEqual(
		[...part.files],
		[
			['1', 'strava_1.gpx'],
			['2', 'strava_2.gpx'],
		],
	);
	assert.equal(part.bytes, repetitive.byteLength * 2);
	assert.ok(part.finish().size < part.bytes / 10, 'repetitive XML compresses well');
});
