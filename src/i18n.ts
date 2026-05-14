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
 * Look up a localized string by key. `substitutions` map to `$1`, `$2`, … in
 * the message template (see Chrome's i18n placeholders documentation).
 *
 * Returns the key itself as a last-resort fallback, so missing entries are
 * visible in the UI during development rather than collapsing to "".
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
	const msg = chrome.i18n.getMessage(key, substitutions);
	return msg || key;
}
