// Content script for an activity page (https://www.strava.com/activities/<id>).
// Strava's "…" menu offers Export GPX and Export Original but not TCX, even
// though /activities/<id>/export_tcx serves one - this adds the missing item
// right after Export GPX.
//
// Kept separate from content.ts: it needs no zip library, toolbar or
// storage, so activity pages only load this small script.

import { t } from './i18n.ts';

/**
 * Add "Export TCX" after Strava's own "Export GPX" menu item, as a copy of
 * that item so it inherits Strava's menu markup and styling. Only on
 * activities that also offer Export Original: that item appears only on your
 * own activities, and Strava's TCX export needs GPS data just as GPX does.
 *
 * Returns true once a TCX item exists (ours, or Strava's should it ever add
 * one), so the caller can stop watching the page.
 */
function addTcxMenuItem(): boolean {
	if (document.querySelector('a[href$="/export_tcx"]')) return true;
	const gpxLink = document.querySelector<HTMLAnchorElement>('a[href$="/export_gpx"]');
	if (!gpxLink || !document.querySelector('a[href$="/export_original"]')) return false;

	const item = gpxLink.closest('li') ?? gpxLink;
	const copy = item.cloneNode(true) as HTMLElement;
	const link = copy instanceof HTMLAnchorElement ? copy : copy.querySelector('a')!;
	link.setAttribute('href', gpxLink.getAttribute('href')!.replace(/export_gpx$/, 'export_tcx'));
	// Reuse Strava's own wording ("Export GPX" in whatever language the page
	// is in) when it names the format; fall back to our translation.
	const label = (gpxLink.textContent ?? '').trim();
	link.textContent = label.includes('GPX') ? label.replace(/GPX/g, 'TCX') : t('exportTcx');
	link.dataset.sbgxTcx = '1';
	item.after(copy);
	return true;
}

function start(): void {
	if (addTcxMenuItem()) return;
	// Strava renders the menu server-side today, so this normally finishes on
	// the first pass. Keep watching in case it arrives later; on activities
	// that can't be exported (someone else's, no GPS) the check stays cheap.
	const obs = new MutationObserver(() => {
		requestAnimationFrame(() => {
			if (addTcxMenuItem()) obs.disconnect();
		});
	});
	obs.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
