// Unit tests for the activity list CSV (csv.ts): its columns, quoting,
// formula defusing, and reading activity ids back out of a CSV.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/dom.ts';
import { activitiesCsv, activityIdsFromCsv, parseCsv } from '../../src/csv.ts';
import type { ActivityRow } from '../../src/types.ts';

function row(id: string, name: string, extra: Partial<ActivityRow> = {}): ActivityRow {
	return {
		id,
		name,
		sport_type: 'Run',
		date: '2026-05-06',
		hasGps: true,
		columns: [
			{ label: 'Sport', value: 'Run' },
			{ label: 'Title', value: name },
			{ label: 'Distance', value: '10.07 km' },
		],
		...extra,
	};
}

void test('a list export has id, URL, ISO date and the table columns under their own headers', () => {
	const csv = activitiesCsv([row('1', 'Morning Run')]);
	assert.ok(csv.startsWith('﻿'), 'starts with a BOM for Excel');
	assert.ok(csv.endsWith('\r\n'));
	assert.deepEqual(parseCsv(csv), [
		['Activity ID', 'URL', 'Date (YYYY-MM-DD)', 'Sport', 'Title', 'Distance'],
		['1', 'https://www.strava.com/activities/1', '2026-05-06', 'Run', 'Morning Run', '10.07 km'],
	]);
});

void test('a zip summary adds the File column, and an unread date is left empty', () => {
	const files = new Map([['1', 'Run/1_Morning Run.gpx']]);
	const rows = parseCsv(activitiesCsv([row('1', 'Morning Run', { date: null }), row('2', 'Other')], files));
	assert.deepEqual(rows[0]!.slice(0, 4), ['Activity ID', 'URL', 'File', 'Date (YYYY-MM-DD)']);
	assert.deepEqual(rows[1]!.slice(2, 4), ['Run/1_Morning Run.gpx', '']);
	assert.equal(rows[2]![2], '');
});

void test('commas, quotes and line breaks survive a round trip', () => {
	const title = 'Lunch, "easy"\nwith Ana';
	const rows = parseCsv(activitiesCsv([row('1', title)]));
	assert.equal(rows[1]![4], title);
});

void test('cells a spreadsheet would run as a formula are defused', () => {
	for (const title of ['=HYPERLINK("http://x")', '+1', '-1', '@SUM(A1)']) {
		const rows = parseCsv(activitiesCsv([row('1', title)]));
		assert.equal(rows[1]![4], `'${title}`);
	}
});

void test('columns are the union of every row’s, in first-seen order', () => {
	const other = row('2', 'Ride', { columns: [{ label: 'Elevation', value: '587 m' }] });
	const rows = parseCsv(activitiesCsv([row('1', 'Run'), other]));
	assert.deepEqual(rows[0]!.slice(3), ['Sport', 'Title', 'Distance', 'Elevation']);
	assert.deepEqual(rows[2]!.slice(3), ['', '', '', '587 m']);
});

void test('activity ids are read from the first column, skipping the header and duplicates', () => {
	const ours = activitiesCsv([row('9000000001', 'A'), row('9000000002', 'B')]);
	assert.deepEqual(activityIdsFromCsv(ours), ['9000000001', '9000000002']);
	const stravaArchive = 'Activity ID,Activity Date,Activity Name\r\n123,"May 6, 2026",Run\r\n123,x,y\r\n456,x,y\r\n';
	assert.deepEqual(activityIdsFromCsv(stravaArchive), ['123', '456']);
	assert.deepEqual(activityIdsFromCsv('name,id\r\nRun,1\r\n'), []);
});
