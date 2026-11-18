// Unit tests for the custom Hide start/end distance's unit and labels.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultLengthUnit, lengthLabel, unitName } from '../../src/units.ts';

void test('feet where the locale measures in feet, metres elsewhere', () => {
	assert.equal(defaultLengthUnit('en-US'), 'ft');
	assert.equal(defaultLengthUnit('en'), 'ft');
	assert.equal(defaultLengthUnit('my'), 'ft');
	assert.equal(defaultLengthUnit('en-GB'), 'm');
	assert.equal(defaultLengthUnit('de'), 'm');
	assert.equal(defaultLengthUnit('es-US'), 'ft');
	assert.equal(defaultLengthUnit('not a locale!'), 'm');
});

void test('labels follow the locale', () => {
	assert.equal(lengthLabel(650, 'ft', 'en-US'), '650 ft');
	assert.equal(lengthLabel(1200.5, 'm', 'de'), '1.200,5 m');
	assert.equal(lengthLabel(213.3333, 'm', 'en'), '213.33 m');
	assert.equal(unitName('m', 'en'), 'm');
	assert.equal(unitName('ft', 'en'), 'ft');
});
