// Unit tests for reading a table cell as a distance - what decides whether a
// row gets GPX/TCX controls.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceShown } from '../../src/distance.ts';

void test('kilometres and miles, with either decimal separator', () => {
	assert.equal(distanceShown('48.11 km'), true);
	assert.equal(distanceShown('10,07 km'), true);
	assert.equal(distanceShown('1,234.5 mi'), true);
	assert.equal(distanceShown('0.4 mi'), true);
	assert.equal(distanceShown('  5.00 km  '), true);
});

void test('swims in metres and yards count as distances', () => {
	assert.equal(distanceShown('1,500 m'), true);
	assert.equal(distanceShown('1 650 yd'), true);
	assert.equal(distanceShown('750m'), true);
});

void test('units Strava translates on localized pages', () => {
	assert.equal(distanceShown('10,07 км'), true);
	assert.equal(distanceShown('1 234,5 км'), true);
	assert.equal(distanceShown('5.00 公里'), true);
	assert.equal(distanceShown('3,2 mi.'), true);
});

void test('zero in any notation is no distance covered', () => {
	assert.equal(distanceShown('0 km'), false);
	assert.equal(distanceShown('0.00 km'), false);
	assert.equal(distanceShown('0,0 mi'), false);
	assert.equal(distanceShown('0 м'), false);
});

void test('times, dates, bare numbers and text are not distances', () => {
	assert.equal(distanceShown('46:22'), null);
	assert.equal(distanceShown('5:32:41'), null);
	assert.equal(distanceShown('109'), null);
	assert.equal(distanceShown('Sat, 09/05/2026'), null);
	assert.equal(distanceShown('09.05.2026'), null);
	assert.equal(distanceShown('2026年5月9日'), null);
	assert.equal(distanceShown('Trail Run'), null);
	assert.equal(distanceShown(''), null);
	assert.equal(distanceShown('--'), null);
});
