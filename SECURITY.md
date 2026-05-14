# Security policy

## Supported versions

Only the latest published `v*` tag is supported. Older versions do not receive backports.

## Reporting a vulnerability

If you think you've found a security issue (especially anything that could affect
a user's Strava session - e.g., the extension making requests to origins other
than `strava.com`, accidentally exposing session cookies, executing untrusted
strings, or escalating the content-script's `matches` pattern), please **do not
open a public issue**. Instead, file a private report via GitHub:

[**Report a vulnerability**](https://github.com/mladimatija/strava-bulk-gpx/security/advisories/new)

That link uses GitHub's private security advisories - the report is only visible
to repository maintainers until a fix ships.

Please include:

- A concise description of the issue and the impact you observed.
- Reproduction steps (a fixture HTML snippet, a recipe with a screenshot, or
  a minimal patch demonstrating the problem).
- The extension version (visible at `chrome://extensions` after enabling
  Developer mode) and the Chrome version you tested against.

I'll acknowledge receipt within a few days, work on a fix in a private branch,
and coordinate disclosure with you before publishing the fix and a release note.

## Scope

In scope:

- The extension code in `src/`, `manifest.json`, `_locales/`, build scripts in
  `scripts/`, and the CI/release workflows under `.github/workflows/`.
- Anything that could compromise a user's Strava session or extract data
  beyond what the user explicitly requested (clicked) to download.

Out of scope:

- Issues in upstream dependencies that are publicly tracked elsewhere (please
  file those upstream; we'll pick up the bump via Dependabot).
- The Strava website itself or Strava's export endpoints - those are not part
  of this project.
- Reports requiring the user to install a tampered build of this extension from
  somewhere other than the Chrome Web Store or the official `v*` release zip.
