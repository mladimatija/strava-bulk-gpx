# Contributing

Thanks for your interest in improving Strava Bulk GPX Export! This is a small project - feature ideas, bug reports, and code contributions are all welcome.

## Getting the dev environment running

Requirements:

- Node.js **>= 24** (matches the Vite 8 / Rolldown toolchain we build against in CI).
- A Chromium-based browser (Chrome / Brave / Edge / Arc) for loading the unpacked extension.

```bash
git clone https://github.com/mladimatija/strava-bulk-gpx.git
cd strava-bulk-gpx
npm install
npm run build
```

Load the unpacked extension:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked**, pick the `dist/` folder.

Iterate with `npm run dev` for HMR, or `npm run build` then click the reload icon next to the extension in `chrome://extensions`.

## What `npm run check` does

`check` is the umbrella command that gates PRs. It runs:

- `npm run lint` - ESLint flat config, type-aware rules for `src/**/*.ts`.
- `npm run format:check` - Prettier verification (use `npm run format` to fix).
- `npm run type-check` - `tsc --noEmit` against the project tsconfig.

CI runs the same three as separate jobs plus a build job. Run `npm run check` locally before pushing to avoid the CI ping-pong.

## Pre-commit hooks

`simple-git-hooks` + `lint-staged` are installed; they're activated by `npm install` (via the `postinstall` step). On commit, only staged files are linted/formatted.

If you skip a hook with `--no-verify`, expect CI to catch the same issues.

## Code style

- TypeScript everywhere in `src/`. Build scripts in `scripts/` are Node ESM JS.
- Strict ESLint and Prettier configs are the source of truth; don't manually nudge formatting.
- Functions get JSDoc comments when their behaviour isn't obvious from the name.

## Filing issues

Use the bug report or feature request template (you'll be prompted on https://github.com/mladimatija/strava-bulk-gpx/issues/new/choose). The templates exist to save us back-and-forth - please fill out the version + repro steps, otherwise the issue may sit until I can guess at the missing context.

**Security issues should NOT use the public issue tracker** - please follow the disclosure process in [`SECURITY.md`](SECURITY.md).

## Pull request flow

1. Fork → create a branch → push.
2. Open the PR with the PR template filled in.
3. CI runs `check` + `build`. Green is required for merge.
4. Reviews are usually within a few days; I do this on the side.
5. PRs land as a merge commit, so every commit on your branch ends up on `main` as-is. Keep them focused - one logical change per commit, with a message that says why - and tidy them up before asking for review.

## Releases

Releases are tagged `vMAJOR.MINOR.PATCH`. Pushing a tag triggers `release.yml`, which builds, runs `check`, packages `dist/` as `strava-bulk-gpx.zip`, and attaches it to a GitHub Release with auto-generated release notes.

`package.json.version` is the source of truth - `manifest.json.version` is overwritten at build time by `vite.config.ts` (a small `toChromeVersion()` helper strips SemVer prerelease suffixes so Chrome's manifest format stays happy), so don't edit it directly.

To cut a release, bump the version inside the PR and tag only after it's merged - a pushed tag publishes a release, so it must point at reviewed code on `main`:

1. On the PR's branch, bump without tagging and commit it as `chore: bump version to X.Y.Z`:

   ```bash
   npm version minor --no-git-tag-version   # or patch / major; bumps package.json + package-lock.json
   ```

   In the same commit, add `## [X.Y.Z] - YYYY-MM-DD` right under `## [Unreleased]` in `CHANGELOG.md` (the entries collected there become that version's), and if `PRIVACY.md` changed in this release, set its effective date.

2. Let CI pass and merge the PR.
3. Tag the merge commit on `main` and push just that tag:

   ```bash
   git switch main && git pull
   git tag vX.Y.Z            # lightweight tag on the merge commit
   git push origin vX.Y.Z    # triggers release.yml
   ```

4. Once `release.yml` has published the GitHub Release, upload its `strava-bulk-gpx.zip` to the Chrome Web Store by hand.

Avoid `npm version` without `--no-git-tag-version` (it tags the bump commit on the branch) and `git push --follow-tags` (it pushes that tag, and so publishes a release, before the PR is merged).

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
