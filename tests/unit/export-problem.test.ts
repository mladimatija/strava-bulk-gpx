// Unit tests for telling an export file from Strava's answer to an export it
// doesn't have. Redirects can't be exercised in the e2e suite: Playwright
// doesn't route the request that follows one, so it would reach strava.com.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportProblem } from '../../src/downloader.ts';

function response(init: { status?: number; url?: string; type?: string }) {
	const status = init.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		url: init.url ?? 'https://www.strava.com/activities/1/export_gpx',
		headers: new Headers(init.type ? { 'content-type': init.type } : {}),
	};
}

void test('a file is fine, even after a redirect', () => {
	assert.equal(exportProblem(response({ type: 'application/gpx+xml' }), 'gpx'), null);
	assert.equal(exportProblem(response({ type: 'application/octet-stream' }), 'original'), null);
	const cdn = response({ url: 'https://cdn.example/upload.fit', type: 'application/octet-stream' });
	assert.equal(exportProblem(cdn, 'original'), null);
});

void test('an HTTP error reports its status', () => {
	assert.equal(exportProblem(response({ status: 500 }), 'gpx'), 'HTTP 500');
});

void test('a redirect to the login page means the session ended', () => {
	const res = response({ url: 'https://www.strava.com/login', type: 'text/html' });
	assert.equal(exportProblem(res, 'gpx'), 'not logged in to Strava');
	const session = response({ url: 'https://www.strava.com/session/new', type: 'text/html' });
	assert.equal(exportProblem(session, 'tcx'), 'not logged in to Strava');
});

void test('any other web page means Strava has no such file', () => {
	const dashboard = response({ url: 'https://www.strava.com/dashboard', type: 'text/html' });
	assert.equal(exportProblem(dashboard, 'gpx'), 'Strava has no GPX file for this activity');
	assert.equal(exportProblem(dashboard, 'tcx'), 'Strava has no TCX file for this activity');
	const page = response({ type: 'text/html; charset=utf-8' });
	assert.equal(exportProblem(page, 'original'), 'Strava has no Original file for this activity');
});
