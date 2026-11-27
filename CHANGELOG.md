# Changelog

All notable changes will be documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are SemVer.

## [Unreleased]

## [1.5.0] - 2026-11-27

### Added

- **Save selected to a folder.** **⋯ → Save selected to a folder…** asks for a folder (the browser's own picker) and writes each file straight into it as it arrives: no zip, no **Save part N** clicks, and nothing in memory beyond the file being written. Sport folders become real subfolders, and a `strava_activities_<date>.csv` lists what was written. A file already there under the same name is replaced when it's the same size, and otherwise left alone - the new one gets `-2`, `-3`, …. Export history is recorded as files land (in batches of 25), so **Cancel** keeps what's in the folder and says how many files that is; **Retry N failed** writes into the same folder. Uses the File System Access API - no new permission - and is hidden where the browser has no folder picker. Checked in the e2e suite against a real directory handle (the page's origin-private folder), since Chrome's picker can't be driven by a test.
- **Merge into GeoJSON.** A third **⋯ → Merge GPX into** option: `strava_merged_<date>.geojson`, a FeatureCollection (RFC 7946) with a LineString per activity - a MultiLineString when it has several segments - in time order, with the activity's id, name, sport, start time and URL as properties. For web maps and GIS tools. Per-point times and sensor data are left out.

### Changed

- **Zips are built with fflate instead of JSZip**, compressing each file as it's added rather than holding every file until the end, so a zip part's memory use is its compressed size. The content script went from 142 KB to 62 KB.
- **Row download failures show on the status line** (and in the button's tooltip) instead of a blocking `alert()`.
- **`content.ts` is split up**: state and preferences (`state.ts`), reading Strava's table (`table.ts`, `distance.ts`), the pager (`paging.ts`), the toolbar's markup (`toolbar-html.ts`), merging (`merge.ts`), the zip writer (`zip.ts`) and folder writes (`folder.ts`).
- **The English fallback strings are generated** from `_locales/en/messages.json` (`npm run i18n` → `src/i18n-messages.ts`) instead of being kept in step by hand.
- **Unit tests for merging, trimming, the CSV, the zip writer, folder writes and the message files** (56, up from 17), with jsdom supplying the DOM for the XML modules. The message-file tests check that every locale has every message with the same placeholders, and that the store description fits 132 characters.
- **The page observer does less work.** A burst of mutations schedules one pass instead of one per mutation, and the toolbar's own updates (the status line changes with every file) no longer trigger any.
- **Releases can upload to the Chrome Web Store.** `release.yml` uploads the release zip through the Chrome Web Store API (V2) when the repository has the credentials configured, and submits it for review only when `CWS_AUTO_PUBLISH` is `true`. Without credentials the step is skipped, as before. It also runs the unit tests before packaging.

### Fixed

- **Activities shown in other units had no GPX/TCX controls.** A row counted as having GPS only when its distance read `km` or `mi`, so swims listed in metres or yards - and every row on a page where Strava translates the unit - got no checkbox or button outside Original mode. Any unit now counts; the distance is read from Strava's `col-dist` cell where the table has one, and the title cell is never mistaken for a distance. Not checked against strava.com in other languages - the fixtures cover it.
- **Row downloads ignored rate limits.** A row's own button failed at once on HTTP 429; it now waits for Strava's `Retry-After` and retries, like bulk downloads, with the wait shown on the status line.
- **Untranslated errors.** "All N downloads failed…", "None of the TCX files could be read." and the invalid-file reasons were English in every language.

### Removed

- The unused `downloadSingleGpx`, `downloadBulkGpx` and `downloadMergedGpx` aliases.

## [1.4.0] - 2026-11-18

### Added

- **Select all pages / Select new on all pages.** Two toolbar buttons page through Strava's whole activity list with its own ← → buttons - back to the first page, then on to the last - selecting every activity, or only those not yet exported in the current format. Strava's search and filters scope them. Progress shows Strava's own "21-40 of 3433"; **Cancel** keeps what was selected so far. Checked against strava.com: the pager is `.pagination` with a `button.next_page` that becomes a disabled `<span>` on the last page, and a page takes about 0.7 s, so a 3,400-activity account takes about two minutes. No new endpoint and no new permission.
- **The selection survives a reload.** It's saved in `chrome.storage.local` and restored within a day of the last change - older selections are dropped, and so is one that was fully downloaded as a zip (it stays selected on screen), so a finished batch can't quietly join the next backup. **Clear selection** removes it. Activities the restored format can't export are left out, and Select all pages saves once, when it's done.
- **Split zips.** **⋯ → Split zips after** (250 MB, 500 MB by default, 1 GB, never; remembered) starts a new zip once the files in the current one reach that size before compression. Each part - `strava_<format>_<date>_part1.zip`, … - is saved as soon as it's full, with its own `activities.csv`, so a large backup never sits in memory whole. Chrome lets a site start one download without a click and holds back or blocks the rest, so from part 2 on a **Save part N** button appears and fetching waits for it. Names are unique across all parts; parts are numbered when they fill up and saved one at a time; a part that can't be saved lists its activities as failures (with Retry). History is recorded per saved part, and cancelling keeps the parts already saved.
- **Date + title file names.** A new **Names** option: `<YYYY-MM-DD>_<title>.<ext>`. Strava's Date column is display text in the athlete's format ("Tue, 17/11/2026" or "Tue, 11/17/2026"); day-first and month-first are told apart by a day above 12, the weekday name, or any other row of the table that settles the order. Unreadable dates fall back to `<id>_<title>`.
- **Date column in CSVs.** `activities.csv` and Export list gain a `Date (YYYY-MM-DD)` column after the file name, since Strava's own Date column doesn't sort.
- **Indoor activities in Original mode.** Rows without GPS get a checkbox and button in Original mode: checked against strava.com, their `/export_original` is the uploaded FIT file (a trainer ride's power, a strength session's heart rate), while GPX and TCX redirect to a web page. Switching to GPX or TCX deselects them, with a message saying how many.
- **Custom Hide start/end distance.** **⋯ → Hide start/end → Custom…** shows a number input with a metres/feet dropdown, defaulting to feet where the browser's locale measures in feet (US, Liberia, Myanmar). Switching the unit doesn't convert the number. The chip shows the distance as typed ("Hiding 700 ft at start and end"); the file's note gives it in whole metres. Not remembered, like the presets.
- **Hide start/end for TCX.** Trackpoints near the start and end lose their `<Position>` but keep time, distance, heart rate, cadence and power; each `<Track>` is split where hidden and visible points meet; the activity's `<Notes>` records the trimming; files are named `…_trimmed.tcx`. Applies to row downloads, zips and TCX merges. Only Original mode now disables the setting.

### Changed

- **Tests run headless.** The Playwright suite runs Chromium's new headless mode (`channel: 'chromium'`), which loads extensions, so `npm test` no longer opens windows or needs `xvfb-run`; `PWTEST_HEADED=1` shows the window. A Node unit-test layer (`npm run test:unit`, no new dependency) covers date parsing, export-response checks and Original file naming, with its own CI job.

### Fixed

- **Web pages saved as activity files.** An export Strava doesn't have answers with a redirect to an HTML page and HTTP 200, so a zip could contain a `.gpx` that was really Strava's dashboard. HTML responses are now failures, listed with the reason ("Strava has no GPX file for this activity", or "not logged in to Strava" when it's the login page). A redirect that ends in a file is still fine.
- **Single downloads** are fetched instead of linked, so a missing file - an indoor Original, or a GPX of a treadmill run that shows a distance but has no track - shows an error instead of saving Strava's page or navigating to it. An Original whose `Content-Disposition` has no usable name gets its extension from its bytes (FIT, gzip, GPX, TCX); `filename*=` in charsets other than UTF-8 and quoted names with `\"` are read too.
- **Malformed merged, joined and trimmed files.** Files the extension builds had two XML declarations - the one `XMLSerializer` keeps from the parsed Strava export, and one added in front - which strict XML parsers reject. Every merged GPX since merging was added, and 1.3.0's joined GPX, merged TCX and trimmed GPX, were affected. They now have exactly one, and the tests check every generated file parses.
- **Lost export history.** Two exports finishing moments apart in one tab - two quick row downloads, or two zip parts - could both read the old history, so the second write dropped the first's activities. Writes are now queued, and **Forget export history** waits for them, so a write in flight can't bring the history back.
- **⋯ menu off-screen.** When the toolbar wraps and puts **⋯** near its left edge, the menu now opens rightwards instead of past the edge of the window.

## [1.3.0] - 2026-11-07

### Added

- **Export TCX on activity pages.** Your own activity pages get an **Export TCX** item in Strava's "…" menu, right after Export GPX (Strava serves `/export_tcx` but doesn't list it). Runs as a separate ~1 KB content script on `https://www.strava.com/activities/*`; no new permission.
- **Export history and Select new.** Activities exported through a zip or a row button are remembered per format in `chrome.storage.local`: a ✓ appears beside the row button (tooltip shows the date), and a new **Select new** button selects only the rows not exported yet in the current format - a weekly backup is Select new → Download selected. Merges, list exports and failed downloads don't count.
- **Join into one activity (GPX).** A new **⋯ → Merge GPX into → One activity** setting (remembered) turns the merge button into **Join selected into one activity**: `strava_joined_<date>.gpx` has one track with a segment per activity, in time order - the shape to upload back to Strava as a single activity. Activities that overlap in time are refused. Checked against strava.com with two real runs: while the originals exist, Strava rejects the joined file as a duplicate of the earliest, so they have to be deleted first.
- **TCX merge.** The merge button now works in TCX mode: one activity whose laps are every selected activity's laps, in time order, with trackpoint distances carrying on and mixed sports set to "Other". Several `<Activity>` elements in one file would be schema-valid, but Strava and Garmin Connect only import one activity per TCX reliably. The button is now disabled only in Original mode.
- **Hide start/end (GPX).** **⋯ → Hide start/end** removes track points within 200 m / 500 m / 1 km of each activity's start and end before saving, since Strava's map-visibility hiding doesn't apply to your own exports. It's a straight-line radius, so mid-route passes near home are hidden too, and the track is split into segments there instead of being drawn across the gap. Trimmed files are named `…_trimmed.gpx`, note the trimming in `<metadata><desc>`, and don't count as exported. Deliberately not remembered: it resets on reload, and a toolbar chip shows while it's on. Applies to row downloads, zips and merges.
- **⋯ menu** on the toolbar, for rarely touched settings and actions: the GPX merge mode, Hide start/end, marking the activities in an earlier `activities.csv` (ours, or Strava's account archive) as exported, and forgetting the export history (inline two-click confirmation).

### Fixed

- **Column headers lined up with the wrong columns.** Strava's activities table sizes its columns from the header row (`table-layout: fixed`), and the extension's extra checkbox and button cells were only added to the body rows - so on the real page every value sat one column right of its heading ("Run" under Date, the date under Title, …) since 1.0. The header row now gets matching cells.

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
