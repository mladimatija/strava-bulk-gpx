// Unit tests for reading activity dates from Strava's Date column. Strava
// shows the date in the athlete's own format, so these cover the formats and
// the ways day-first and month-first are told apart.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateOrderOf, isoDate } from '../../src/dates.ts';

void test('a day above 12 settles day-first and month-first', () => {
	assert.equal(isoDate('Tue, 17/11/2026', 'en-GB', null), '2026-11-17');
	assert.equal(dateOrderOf('Tue, 17/11/2026', 'en-GB'), 'dmy');
	assert.equal(isoDate('Tue, 11/17/2026', 'en-US', null), '2026-11-17');
	assert.equal(dateOrderOf('Tue, 11/17/2026', 'en-US'), 'mdy');
});

void test('the weekday settles it when both readings are valid', () => {
	// 8 May 2026 is a Friday, 5 August a Wednesday.
	assert.equal(isoDate('Fri, 08/05/2026', 'en', null), '2026-05-08');
	assert.equal(dateOrderOf('Fri, 08/05/2026', 'en'), 'dmy');
	assert.equal(isoDate('Wed, 08/05/2026', 'en', null), '2026-08-05');
	assert.equal(dateOrderOf('Wed, 08/05/2026', 'en'), 'mdy');
});

void test('weekday names are compared in the page language', () => {
	// 4 May 2026 is a Monday ("Mo."), 5 April a Sunday.
	assert.equal(isoDate('Mo., 04.05.2026', 'de', null), '2026-05-04');
	assert.equal(isoDate('lun. 04/05/2026', 'fr', null), '2026-05-04');
});

void test('an ambiguous date takes the order learned from other rows', () => {
	// 9 May and 5 September 2026 are both Saturdays.
	assert.equal(isoDate('Sat, 09/05/2026', 'en', null), null);
	assert.equal(dateOrderOf('Sat, 09/05/2026', 'en'), null);
	assert.equal(isoDate('Sat, 09/05/2026', 'en', 'dmy'), '2026-05-09');
	assert.equal(isoDate('Sat, 09/05/2026', 'en', 'mdy'), '2026-09-05');
});

void test('the same day and month need no order', () => {
	assert.equal(isoDate('05/05/2026', 'en', null), '2026-05-05');
});

void test('year-first dates are unambiguous', () => {
	assert.equal(isoDate('2026/11/17', 'ja', null), '2026-11-17');
	assert.equal(isoDate('2026年11月17日', 'zh-CN', null), '2026-11-17');
	assert.equal(dateOrderOf('2026/11/17', 'ja'), null);
});

void test('text that is not a date has none', () => {
	assert.equal(isoDate('Yesterday', 'en', 'dmy'), null);
	assert.equal(isoDate('1:14:39', 'en', 'dmy'), null);
	assert.equal(isoDate('31/02/2026', 'en', 'dmy'), null);
	assert.equal(isoDate('17/11/26', 'en', 'dmy'), null);
});
