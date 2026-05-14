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
5. Squash-merge on landing. Keep your branch's commit history clean if you can - it ends up in the squash message.

## Releases

Releases are tagged `vMAJOR.MINOR.PATCH`. Pushing a tag triggers `release.yml`, which builds, runs `check`, packages `dist/` as `strava-bulk-gpx.zip`, and attaches it to a GitHub Release with auto-generated release notes.

`package.json.version` is the source of truth - `manifest.json.version` is overwritten at build time by `vite.config.ts` (a small `toChromeVersion()` helper strips SemVer prerelease suffixes so Chrome's manifest format stays happy), so don't edit it directly.

To cut a release locally:

```bash
npm version patch    # or minor / major; bumps package.json
git push --follow-tags
```

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
