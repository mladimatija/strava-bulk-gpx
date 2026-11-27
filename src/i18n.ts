/**
 * Localization helper. Wraps `chrome.i18n.getMessage()` with a typed key set,
 * so a typo in a translation key is a compile-time error rather than a silent
 * empty string at runtime.
 *
 * `chrome.i18n.getMessage` works in content scripts without any permission
 * (one of the few `chrome.*` APIs that does). Chrome resolves the right
 * locale based on the user's browser language; if there's no translation for
 * a key in the active locale, it falls back to the `default_locale` declared
 * in the manifest (currently `en`).
 *
 * ## Why we still keep a baked-in English fallback
 *
 * Empirically, `chrome.i18n` is sometimes `undefined` when the content
 * script's bundle runs - most often because @crxjs/vite-plugin's dynamic
 * import loader lands the chunk in the page's main world (where `chrome`
 * exists as a stripped page-side object without `i18n`) instead of the
 * isolated content-script world. Without a fallback, the toolbar throws
 * `Cannot read properties of undefined (reading 'getMessage')` at mount.
 *
 * `i18n-messages.ts` holds that copy. It is generated from
 * `_locales/en/messages.json` (`npm run i18n`), so the two can't drift, and
 * is used only when the live `chrome.i18n` lookup fails. Substitutions
 * follow the same `$1`, `$2`, ... syntax Chrome's i18n placeholders compile
 * to.
 *
 * See `_locales/en/messages.json` for the source-of-truth string set.
 */

import { EN_MESSAGES } from './i18n-messages.ts';

/** Every message key in `_locales/en/messages.json`. */
export type MessageKey = keyof typeof EN_MESSAGES;

/**
 * Apply Chrome-style `$1`, `$2`, ... substitutions to a template string.
 * Mirrors the behaviour of `chrome.i18n.getMessage()`'s second argument.
 */
function applySubstitutions(template: string, substitutions?: string | string[]): string {
	if (substitutions === undefined) return template;
	const args = Array.isArray(substitutions) ? substitutions : [substitutions];
	return template.replace(/\$(\d+)/g, (_, idx: string) => args[Number(idx) - 1] ?? '');
}

/**
 * Look up a localized string by key. `substitutions` map to `$1`, `$2`, ... in
 * the message template (see Chrome's i18n placeholders documentation).
 *
 * The lookup order is:
 *   1. `chrome.i18n.getMessage(key, substitutions)` - resolves the right
 *      locale and returns the translated string.
 *   2. `EN_MESSAGES[key]` with substitutions applied locally - used when
 *      `chrome.i18n` is unavailable in the current execution context.
 *   3. The key itself - last-resort fallback so missing entries are visible
 *      in the UI during development rather than collapsing to "".
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
	// chrome.i18n.getMessage is the happy path; in some build configurations
	// (notably MV3 content scripts loaded via dynamic import) `chrome.i18n`
	// can be undefined, so we guard defensively and fall through to the
	// baked-in English map below.
	try {
		const i18n = (globalThis as { chrome?: { i18n?: typeof chrome.i18n } }).chrome?.i18n;
		if (i18n && typeof i18n.getMessage === 'function') {
			const msg = i18n.getMessage(key, substitutions);
			if (msg) return msg;
		}
	} catch {
		// fall through to the fallback path
	}

	const template: string | undefined = EN_MESSAGES[key];
	if (template) return applySubstitutions(template, substitutions);
	return key;
}
