// Renders icons/icon.svg to the three PNG sizes Chrome requires for an MV3
// extension (16, 48, 128). Wired as a `prebuild` hook so `npm run build`
// regenerates them automatically; skips when the PNGs are newer than
// the SVG, so re-runs cost essentially nothing.

import { readFile, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'icons', 'icon.svg');
const sizes = [16, 48, 128];

const svgStat = await stat(src);
const svgBytes = await readFile(src);
await mkdir(path.join(root, 'icons'), { recursive: true });

for (const size of sizes) {
	const out = path.join(root, 'icons', `icon-${size}.png`);
	let fresh = false;
	try {
		const outStat = await stat(out);
		fresh = outStat.mtimeMs >= svgStat.mtimeMs;
	} catch {
		/* file doesn't exist yet - will render */
	}
	if (fresh) {
		console.log(`skip icon-${size}.png (up to date)`);
		continue;
	}
	await sharp(svgBytes, { density: 384 }).resize(size, size).png().toFile(out);
	console.log(`wrote icon-${size}.png`);
}
