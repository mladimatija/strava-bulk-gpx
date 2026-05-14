# Privacy Policy

**Effective date:** 2026-05-14

This extension is designed so that it cannot, by construction, collect or transmit your data to anyone except Strava itself. Read this page to understand exactly how that works.

## What the extension can access

When you visit `https://www.strava.com/athlete/training`, the extension is allowed to:

- Read and modify the DOM of that page (to add download buttons and a toolbar).
- Make requests to other URLs on `strava.com` (specifically `/activities/<id>/export_gpx`) **using your existing logged-in browser session**. This is the same URL Strava's own "Export GPX" link on each activity page targets.
- Save files to your computer via the browser's `downloads` API (so the GPX or zip file lands in your Downloads folder).

That's the entire permission surface. The extension does not request access to your cookies as a permission, your browsing history, your other tabs, or any non-Strava domain.

## What we collect, store, or transmit

**Nothing.** This extension has no backend, no analytics, no telemetry, no error reporting service, no remote configuration. Every line of code runs locally in your browser. The only network requests it makes are to `www.strava.com`, and they only happen when you click a download button.

Your Strava session cookie, your activity data, your GPX files, your selections - none of it leaves your machine. We never see it because there is no "we" on the server side.

## Where your data goes

When you click **GPX** on a row or **Download selected** in the toolbar:

1. The extension sends a request to `https://www.strava.com/activities/<id>/export_gpx` - the same URL Strava's own "Export GPX" link targets.
2. Strava streams the GPX file back, byte-for-byte the same file you'd get from clicking that link manually.
3. The browser writes the file (or a zip of multiple files) to your Downloads folder.

Strava is the only third party. Their privacy policy applies to those requests: <https://www.strava.com/legal/privacy>.

## What the extension does _not_ do

- Does not request the `cookies` permission. It cannot read your session cookie value – it relies on the browser's same-origin handling to attach cookies automatically to requests it makes to `strava.com`.
- Does not request `host_permissions` for any site other than the page it's activated on.
- Does not include any analytics or tracking SDKs.
- Does not contain any remote-loaded code. Every byte the extension runs is shipped in the version you install.
- Does not phone home for updates or version checks – Chrome handles updates through the Web Store.

## Open source and verifiable builds

The source code is published at <https://github.com/mladimatija/strava-bulk-gpx>. The build is deterministic - if you run `npm install && npm run build` from a clean clone at the tagged commit, you should get a byte-identical `dist/` directory to what's in the Chrome Web Store listing. If you find a discrepancy, please file an issue.

## Affiliation disclaimer

This extension is not developed, endorsed by, or affiliated with Strava, Inc. "Strava" is a trademark of Strava, Inc.

## Contact

For privacy questions, bugs, and feature requests: <https://github.com/mladimatija/strava-bulk-gpx/issues>
