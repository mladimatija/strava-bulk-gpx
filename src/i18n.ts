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
 * The map below mirrors `_locales/en/messages.json` and is used only when
 * the live `chrome.i18n` lookup fails. Substitutions follow the same `$1`,
 * `$2`, ... syntax Chrome's i18n placeholders compile to.
 *
 * See `_locales/en/messages.json` for the source-of-truth string set.
 */

export type MessageKey =
	| 'extensionName'
	| 'extensionDescription'
	| 'selectAllVisible'
	| 'downloadSelected'
	| 'selectedCount'
	| 'gpxButton'
	| 'gpxButtonTitle'
	| 'preparingDownloads'
	| 'downloadingProgress'
	| 'buildingZip'
	| 'savedActivities'
	| 'savedWithSkips'
	| 'downloadFailed'
	| 'rowDownloadFailed'
	| 'koFiTitle'
	| 'formatLabel'
	| 'formatTcx'
	| 'formatOriginal'
	| 'rowButtonTitle'
	| 'mergeSelected'
	| 'mergingGpx'
	| 'savedMerged'
	| 'mergeOnlyGpx';

/**
 * English string templates, byte-identical to `_locales/en/messages.json`.
 * Placeholders use Chrome's `$NAME$` form during build but compile down to
 * `$1`, `$2`, ... at runtime, which is what we reproduce here.
 */
const EN_FALLBACK: Record<MessageKey, string> = {
	extensionName: 'Strava Bulk GPX Export',
	extensionDescription:
		"Bulk export from Strava's My Activities - GPX, TCX, original files, or one merged GPX. Runs locally in your browser.",
	selectAllVisible: 'Select all visible',
	downloadSelected: 'Download selected',
	selectedCount: '$1 selected',
	gpxButton: 'GPX',
	gpxButtonTitle: 'Download GPX for this activity',
	preparingDownloads: 'Preparing $1 downloads…',
	downloadingProgress: 'Downloading $1 / $2…',
	buildingZip: 'Building zip…',
	savedActivities: 'Saved $1 activities.',
	savedWithSkips: 'Saved $1, skipped $2 ($3)',
	downloadFailed: 'Failed: $1',
	rowDownloadFailed: "Couldn't download $1: $2",
	koFiTitle: 'Buy Me a Coffee at ko-fi.com',
	formatLabel: 'Format:',
	formatTcx: 'TCX',
	formatOriginal: 'Original',
	rowButtonTitle: 'Download $1 for this activity',
	mergeSelected: 'Merge selected into one GPX',
	mergingGpx: 'Merging into one GPX…',
	savedMerged: 'Saved merged GPX with $1 activities.',
	mergeOnlyGpx: 'Merging is only available in GPX mode',
};

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
 *   2. `EN_FALLBACK[key]` with substitutions applied locally - used when
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

	const template = EN_FALLBACK[key];
	if (template) return applySubstitutions(template, substitutions);
	return key;
}
