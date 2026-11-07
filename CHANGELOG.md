# Changelog

All notable changes will be documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are SemVer.

## [Unreleased]

### Added

- **Export TCX on activity pages.** Your own activity pages get an **Export TCX** item in Strava's "…" menu, right after Export GPX (Strava serves `/export_tcx` but doesn't list it). Runs as a separate ~1 KB content script on `https://www.strava.com/activities/*`; no new permission.

## [1.2.0] - 2026-11-07

### Added

- **Selection across pages.** Selected activities stay selected while you page, search or filter in Strava's UI, and **Download selected** / **Merge** / **Export list** include them all. The count reads `N selected (M not on this page)`; a new **Clear selection** action drops everything.
- **Shift-click range selection.** Shift-click a second row checkbox to select or deselect every row in between.
- **File naming.** A new **Names** dropdown (remembered via `chrome.storage.local`): `Activity ID` (the existing `strava_<id>.gpx`), `ID + title` (`<id>_<title>.gpx`), or `Sport folders` (`<sport>/<id>_<title>.gpx` inside zips).
- **`activities.csv` in every multi-file zip**, listing each activity's table columns (as Strava shows them, under Strava's own column headers) plus its id, URL and file name in the zip.
- **Export list (CSV)** toolbar button: saves the selected activities' table columns as `strava_activities_<date>.csv` without fetching any activity files. Formula-like cells are defused against CSV injection.
- **Cancel** button while a download or merge runs; nothing is saved after cancelling.
- **Failure list and Retry.** After a partly failed run, the toolbar lists every failed activity with its reason (previously only the first reason was shown), and zip runs offer **Retry N failed** to fetch only those.
- **Rate-limit handling.** On HTTP 429 the whole download pauses for Strava's `Retry-After` (or 5 / 10 / 20 s backoff, capped at 60 s) and retries the activity up to 3 times, with a status message during the wait.

### Fixed

- **Merged GPX track order.** Tracks were written in whatever order the parallel downloads finished; they're now sorted by start time, so a multi-day trip reads day 1 → day N.
- **Merged GPX schema order.** A source's `<wpt>` waypoints could land after another source's `<trk>`; all waypoints, then routes, then tracks are now emitted across the whole document, as GPX 1.1 requires.
- **Lost files in Original zips.** Two uploads with the same original filename overwrote each other in the zip; duplicates are now renamed `name-2.fit`, `name-3.fit`, ….
- **`PRIVACY.md`** wrongly said files are saved via the `downloads` API (the extension uses ordinary browser downloads and doesn't request that permission) and listed only `/export_gpx`.

## [1.1.0] - 2026-11-05

### Added

- **Remembers the export format.** The last-selected format (`GPX` / `TCX` / `Original`) is restored on the next page load. Stored locally via `chrome.storage.local` (new `storage` permission; see `PRIVACY.md`). Closes #20.

## [1.0.0] - 2026-05-14

Initial public release.

### Added

- **Per-row export.** Each GPS-bearing row in `https://www.strava.com/athlete/training` gets an export button at the end. Indoor / no-GPS activities are skipped (no checkbox, no button).
- **Bulk export.** Multi-select checkboxes plus a `Download selected` button in the toolbar. One row → one file. Multiple rows → a `.zip` with one file per activity, named `strava_<format>_<date>.zip`.
- **Format dropdown.** Choose `GPX` (route only), `TCX` (route + heart rate / cadence / power), or `Original` (the exact `.fit`/`.gpx`/`.tcx` you uploaded). Per-row buttons re-label live as the dropdown changes. Backed by Strava's own `/activities/<id>/export_{gpx,tcx,original}` endpoints - files are byte-for-byte identical to the "Export" menu on individual activity pages.
- **Merge into one GPX.** New toolbar button that fetches every selected activity's GPX, parses each, and emits a single combined `strava_merged_<date>.gpx` with one `<trk>` per activity. Useful for stitching multi-day trips into a single track collection. Per-track `<name>` falls back to the activity title when the source doesn't include one. Available only in GPX mode (with a tooltip explaining why in other modes - TCX and Original aren't trivially concatenable).
- **Filename smarts for `Original`.** RFC 5987 / standard `Content-Disposition` parsing keeps each upload's original extension (`.fit` from Garmin, `.gpx` from a phone, etc.) inside the bulk zip.
- **Progress and status.** Inline spinner plus localized status messages (`Preparing N downloads…`, `Downloading N / M…`, `Building zip…`, `Merging into one GPX…`, terminal success / partial-success / error states).
- **Localization.** 15 locales ship: `en` (source), `de`, `es`, `fr`, `it`, `ja`, `ko`, `nl`, `nb`, `pl`, `pt_BR`, `ru`, `zh_CN`, `zh_TW`, `cs`. Chrome picks the right one based on the user's browser language; missing keys fall back to `en`.
- **Privacy and trust model.** No backend, no analytics, no telemetry, no remote code. Same-origin requests to `strava.com` only, gated on user clicks. See `PRIVACY.md`.
- **End-to-end test suite.** 13 Playwright tests covering toolbar mount, per-row injection, GPS-only filtering, multi-select, format dropdown, all three per-row export paths, and merge.

### Notes

- Manifest V3, declares no permissions or `host_permissions` - the content-script `matches` for `https://www.strava.com/athlete/training*` is the only host capability the extension needs.
- Built with TypeScript 6, Vite 8 (Rolldown), and the `@crxjs/vite-plugin`.

[1.0.0]: https://github.com/mladimatija/strava-bulk-gpx/releases/tag/v1.0.0
