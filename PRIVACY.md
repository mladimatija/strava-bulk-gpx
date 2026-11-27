# Privacy Policy

**Effective date:** 2026-11-18

This extension is designed so that it cannot, by construction, collect or transmit your data to anyone except Strava itself. Read this page to understand exactly how that works.

## What the extension can access

When you visit `https://www.strava.com/athlete/training` or one of your activity pages (`https://www.strava.com/activities/<id>`), the extension is allowed to:

- Read and modify the DOM of that page (to add download buttons and a toolbar on My Activities, and an "Export TCX" item to the "…" menu on activity pages - an ordinary link to Strava's own `/export_tcx` URL).
- Make requests to other URLs on `strava.com` (specifically `/activities/<id>/export_gpx`, `/export_tcx` and `/export_original`) **using your existing logged-in browser session**. These are the same URLs Strava's own "Export" links on each activity page target.
- Click Strava's own ← → page buttons under the activity list, when you click **Select all pages** or **Select new on all pages**, so the list shows each page in turn. Strava then loads those pages exactly as it would if you clicked through them yourself.
- Save files to your computer by triggering an ordinary browser download, the same way clicking a download link does (so the file or zip lands in your Downloads folder). It does not use, or request, the `downloads` permission.
- Write files into a folder **you pick**, when you use **⋯ → Save selected to a folder…**. Chrome shows its own folder picker and asks you to confirm; the extension can then write into that one folder (and subfolders it creates there) until you leave or reload the page. It looks only at the names and sizes of files it is about to write, to avoid overwriting a different file, and reads nothing else. This uses the browser's File System Access API, not an extension permission.
- Store four toolbar preferences in the browser's local extension storage via the `storage` permission, so they are pre-selected next time: your last-used export format (`GPX`, `TCX` or `Original`), your file-naming choice (`Activity ID`, `ID + title`, `Sport folders` or `Date + title`), how GPX files are merged (`Separate tracks`, `One activity` or `GeoJSON`), and the size after which large downloads are split into several zips. These values stay on your machine and are never transmitted. The **Hide start/end** setting is deliberately not stored.
- Store your current selection of activities - for each one, its ID and the columns Strava's table shows for it (date, title, time, distance, …) - in the same local storage, so reloading the page doesn't lose it. It is only restored within a day of your last change, never transmitted, and removed when you click **Clear selection**.
- Store a record of which activities you've exported - activity IDs, format and date - in the same local storage, so already-exported activities can be marked and skipped next time. It never leaves your machine, and **⋯ → Forget export history** deletes it. If you use **⋯ → Mark activities from a CSV as exported**, the extension reads the file you pick locally and keeps only the activity IDs from it.

That's the entire permission surface. The extension does not request access to your cookies as a permission, your browsing history, your other tabs, or any non-Strava domain.

## What we collect, store, or transmit

**Nothing about you.** The only things saved are the toolbar preferences, the export history and the current selection described above, locally. This extension has no backend, no analytics, no telemetry, no error reporting service, no remote configuration. Every line of code runs locally in your browser. The only network requests it makes are to `www.strava.com`, and they only happen when you click a download button - or, for Strava's own list pages, one of the **Select … all pages** buttons.

Your Strava session cookie, your activity data, your GPX files, your selections - none of it leaves your machine. We never see it because there is no "we" on the server side.

## Where your data goes

When you click a row's download button, or **Download selected** / the merge button in the toolbar:

1. The extension sends a request per activity to `https://www.strava.com/activities/<id>/export_gpx` (or `/export_tcx`, `/export_original`, depending on the format you picked) - the same URLs Strava's own "Export" links target.
2. Strava streams each file back, byte-for-byte the same file you'd get from clicking that link manually.
3. The browser writes the file (or a zip of multiple files, plus an `activities.csv` summary built from the table you're looking at) to your Downloads folder.

If **Hide start/end** is on, GPX and TCX files are trimmed in your browser before they're saved; nothing about that is sent anywhere.

**Export list (CSV)** makes no network requests at all: it saves the columns already shown in Strava's table for the activities you selected.

Strava is the only third party. Their privacy policy applies to those requests: <https://www.strava.com/legal/privacy>.

## What the extension does _not_ do

- Does not request the `cookies` permission. It cannot read your session cookie value – it relies on the browser's same-origin handling to attach cookies automatically to requests it makes to `strava.com`.
- Does not request `host_permissions` for any site other than the pages it's activated on.
- Does not include any analytics or tracking SDKs.
- Does not contain any remote-loaded code. Every byte the extension runs is shipped in the version you install.
- Does not phone home for updates or version checks – Chrome handles updates through the Web Store.

## Open source and verifiable builds

The source code is published at <https://github.com/mladimatija/strava-bulk-gpx>. The build is deterministic - if you run `npm install && npm run build` from a clean clone at the tagged commit, you should get a byte-identical `dist/` directory to what's in the Chrome Web Store listing. If you find a discrepancy, please file an issue.

## Affiliation disclaimer

This extension is not developed, endorsed by, or affiliated with Strava, Inc. "Strava" is a trademark of Strava, Inc.

## Contact

For privacy questions, bugs, and feature requests: <https://github.com/mladimatija/strava-bulk-gpx/issues>
