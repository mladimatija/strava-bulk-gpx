// Wipes the `dist/` directory and the root `strava-bulk-gpx.zip` artifact
// before each build, so stale assets (old icons, renamed chunks, content
// scripts from a previous Vite/CRX config) never linger and an out-of-date
// zip from a previous `npm run package` can't end up in a release. Wired
// as the first prebuild step. Cross-platform as uses Node's built-in
// `fs.rmSync` rather than `rm -rf`.

import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const targets = [path.join(repoRoot, 'dist'), path.join(repoRoot, 'strava-bulk-gpx.zip')];
for (const target of targets) {
	rmSync(target, { recursive: true, force: true });
	console.log(`cleaned ${target}`);
}
