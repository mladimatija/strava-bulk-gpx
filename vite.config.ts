import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

/**
 * Convert a SemVer string into a Chrome-manifest-compatible version.
 *
 * Chrome's manifest format only accepts up to four dot-separated integers
 * (e.g. "1.2.3.4"). SemVer prereleases like "0.2.0-beta.1" or "1.0.0+build"
 * are not valid, so we strip everything after the first `-` or `+`. The
 * normalized version is written into the manifest at build time so that
 * `package.json.version` is the single source of truth - never edit
 * `manifest.json.version` by hand.
 */
function toChromeVersion(semver: string): string {
	return semver.split(/[-+]/, 1)[0] ?? semver;
}

const syncedManifest = {
	...manifest,
	version: toChromeVersion(pkg.version),
};

export default defineConfig({
	plugins: [crx({ manifest: syncedManifest })],
	build: {
		// Sourcemaps are intentionally OFF in production builds.
		//
		// @crxjs/vite-plugin wraps content scripts in `(function(){…})()` for
		// browser compatibility, and under Vite 8 / Rolldown it emits the
		// closing `})()` on the same line as Rolldown's
		// `//# sourceMappingURL=…` comment. Single-line comments swallow the
		// rest of the line, so the IIFE never closes, and the bundle fails to
		// parse at load time. Disabling sourcemap removes the comment and
		// sidesteps the bug. Re-enable once upstream is patched.
		sourcemap: false,
		// NOTE: do not set `rolldownOptions` (or `rollupOptions`) here.
		// The CRX plugin already defines its own `rollupOptions` block with
		// content-script input mapping and asset routing; setting either key
		// at this level shadows the plugin's entire config (Vite warns about
		// this as "rollupOptions specified by that plugin will be ignored").
		// If we ever need to extend, do it via a custom plugin's `config`
		// hook so the values merge instead of overwrite.
	},
});
