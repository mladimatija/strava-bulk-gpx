// Unit tests keeping the message files honest: the generated English
// fallback matches `_locales/en/messages.json`, and every locale has every
// message with the same placeholders.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EN_MESSAGES } from '../../src/i18n-messages.ts';
import { t } from '../../src/i18n.ts';

interface Message {
	message: string;
	placeholders?: Record<string, { content: string }>;
}
type Messages = Record<string, Message>;

const localesDir = path.resolve(import.meta.dirname, '../../_locales');

function load(locale: string): Messages {
	return JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8')) as Messages;
}

/** A message as Chrome compiles it: `$NAME$` → its placeholder's `$1`, `$$` → `$`. */
function compiled(entry: Message): string {
	const placeholders = Object.fromEntries(
		Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), p.content]),
	);
	return entry.message.replace(/\$([A-Za-z0-9_@]+)\$|\$\$/g, (token: string, name?: string) =>
		token === '$$' ? '$' : (placeholders[(name ?? '').toLowerCase()] ?? token),
	);
}

const en = load('en');
const locales = readdirSync(localesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

void test('the generated English fallback is up to date (run `npm run i18n`)', () => {
	const expected = Object.fromEntries(Object.entries(en).map(([key, entry]) => [key, compiled(entry)]));
	assert.deepEqual({ ...EN_MESSAGES }, expected);
});

void test('without chrome.i18n, t() falls back to English and substitutes', () => {
	assert.equal(t('selectedCountWithHidden', ['25', '20']), '25 selected (20 not on this page)');
	assert.equal(t('savePart', '2'), 'Save part 2');
	assert.equal(t('cancel'), 'Cancel');
});

void test('every locale has every message, and no others', () => {
	assert.ok(locales.length >= 15);
	for (const locale of locales) {
		assert.deepEqual(Object.keys(load(locale)).sort(), Object.keys(en).sort(), locale);
	}
});

void test('every translation uses exactly the placeholders of the English message', () => {
	const tokens = (message: string): string[] =>
		[...new Set(message.match(/\$[A-Za-z0-9_@]+\$/g) ?? [])].map((token) => token.toUpperCase()).sort();
	for (const locale of locales) {
		for (const [key, entry] of Object.entries(load(locale))) {
			assert.deepEqual(tokens(entry.message), tokens(en[key]!.message), `${locale}: ${key}`);
			for (const token of tokens(entry.message)) {
				const name = token.slice(1, -1).toLowerCase();
				const content = Object.entries(entry.placeholders ?? {}).find(([n]) => n.toLowerCase() === name)?.[1].content;
				assert.ok(content, `${locale}: ${key} has no placeholder for ${token}`);
			}
		}
	}
});

void test('the store description fits the Chrome Web Store limit in every locale', () => {
	for (const locale of locales) {
		const length = load(locale).extensionDescription!.message.length;
		assert.ok(length <= 132, `${locale}: ${length} characters`);
	}
});
