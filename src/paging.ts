// Strava's pager under the activity list ("1-20 of 3433 ← →"), as "Select all
// pages" drives it: its arrows, its text, and turning a page.

import { t } from './i18n.ts';
import { findActivitiesTable } from './table.ts';

/**
 * One of the arrows of Strava's pager under the table ("1-20 of 3433 ← →"),
 * or null when there's no page that way - on the first and last page Strava
 * swaps the button for a disabled <span>.
 */
export function pagerButton(direction: 'previous_page' | 'next_page'): HTMLButtonElement | null {
	const el = document.querySelector(`.pagination .${direction}`);
	return el instanceof HTMLButtonElement && !el.disabled && !el.classList.contains('disabled') ? el : null;
}

/** The pager's "21-40 of 3433", as Strava words it in the page's language. */
export function pagerText(): string {
	return (document.querySelector('.pagination .pages')?.textContent ?? '').trim().replace(/\s+/g, ' ');
}

/** The first row's activity link - it changes when Strava shows another page. */
export function firstRowHref(): string | null {
	return findActivitiesTable()?.querySelector('tbody a[href*="/activities/"]')?.getAttribute('href') ?? null;
}

/** Give up on a page that hasn't loaded after this long. */
const PAGE_TIMEOUT_MS = 30_000;

/**
 * Click a pager arrow and wait for Strava to render the other page. It
 * swaps the whole table out (briefly showing none) for the new one. The
 * caller augments the new rows.
 */
export async function turnPage(button: HTMLButtonElement, signal: AbortSignal): Promise<void> {
	const before = firstRowHref();
	button.click();
	const deadline = Date.now() + PAGE_TIMEOUT_MS;
	for (let now = firstRowHref(); now === null || now === before; now = firstRowHref()) {
		signal.throwIfAborted();
		if (Date.now() > deadline) throw new Error(t('pagingTimeout'));
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
