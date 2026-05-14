// Renders icons/icon.svg into the Chrome Web Store promotional artwork:
//
//   - 440×280 small promo tile (required)
//   - 1400×560 marquee promo tile (optional, but the listing looks better
//     with one)
//
// The tile is just the icon centered on a flat Strava-orange background,
// scaled so the icon takes roughly 60% of the shorter dimension. That gives
// the store thumbnail enough negative space to read at small sizes while
// still recognizing the icon.
//
// Run via `npm run promo`. Output goes to docs/store/.

import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'icons', 'icon.svg');
const outDir = path.join(root, 'docs', 'store');

// Strava orange - same brand color the toolbar's primary button uses, so
// the promo tile feels of-a-piece with the in-page UI.
const BG = '#fc4c02';

const TILES = [
	{ name: 'promo-small.png', width: 440, height: 280 },
	{ name: 'promo-marquee.png', width: 1400, height: 560 },
];

await mkdir(outDir, { recursive: true });
const svgBytes = await readFile(src);

for (const { name, width, height } of TILES) {
	// Icon at ~60% of the shorter dimension - leaves margin for the store
	// to overlay its "Add to Chrome" affordance on hover without clipping
	// anything important.
	const iconSize = Math.round(Math.min(width, height) * 0.6);
	const iconPng = await sharp(svgBytes, { density: 384 }).resize(iconSize, iconSize).png().toBuffer();

	const out = path.join(outDir, name);
	await sharp({
		create: {
			width,
			height,
			channels: 4,
			background: BG,
		},
	})
		.composite([{ input: iconPng, gravity: 'center' }])
		.png()
		.toFile(out);
	console.log(`wrote ${path.relative(root, out)} (${width}×${height})`);
}
