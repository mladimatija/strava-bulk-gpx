// Unit tests for naming Original uploads: the Content-Disposition filename
// Strava sends, and the extension sniffed from the bytes when it gives none.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContentDispositionFilename, sniffExtension } from '../../src/downloader.ts';

void test('plain, quoted and escaped filenames', () => {
	assert.equal(parseContentDispositionFilename('attachment; filename="garmin-upload.fit"'), 'garmin-upload.fit');
	assert.equal(parseContentDispositionFilename('attachment; filename=garmin-upload.fit'), 'garmin-upload.fit');
	assert.equal(parseContentDispositionFilename('attachment; filename="a \\"quoted\\" run.gpx"'), 'a "quoted" run.gpx');
	assert.equal(parseContentDispositionFilename('attachment; filename=   ; size=3'), null);
	assert.equal(parseContentDispositionFilename('attachment'), null);
	assert.equal(parseContentDispositionFilename(null), null);
});

void test('RFC 5987 filenames, in UTF-8 or else ISO-8859-1', () => {
	const utf8 = 'attachment; filename="fallback.fit"; filename*=UTF-8\'\'Jutarnji%20tr%C4%8Dak.fit';
	assert.equal(parseContentDispositionFilename(utf8), 'Jutarnji trčak.fit');
	const latin1 = "attachment; filename*=iso-8859-1'de'Fr%FChlauf.fit";
	assert.equal(parseContentDispositionFilename(latin1), 'Frühlauf.fit');
	// Not valid UTF-8: the plain form is used instead.
	const broken = 'attachment; filename="plain.fit"; filename*=UTF-8\'\'%FF.fit';
	assert.equal(parseContentDispositionFilename(broken), 'plain.fit');
});

void test('the extension is sniffed from FIT, gzip, GPX and TCX bytes', async () => {
	const fit = new Uint8Array([14, 16, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode('.FIT')]);
	assert.equal(await sniffExtension(new Blob([fit])), '.fit');
	assert.equal(await sniffExtension(new Blob([new Uint8Array([0x1f, 0x8b, 8, 0])])), '.gz');
	assert.equal(await sniffExtension(new Blob(['<?xml version="1.0"?>\n<gpx version="1.1">'])), '.gpx');
	assert.equal(await sniffExtension(new Blob(['<?xml version="1.0"?><TrainingCenterDatabase xmlns="x">'])), '.tcx');
	assert.equal(await sniffExtension(new Blob(['something else'])), '');
});
