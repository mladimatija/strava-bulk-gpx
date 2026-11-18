// Fake Strava list pages for the e2e and screenshot specs: rows shaped like
// the fixture's, and Strava's pager under the table.

import type { Page } from '@playwright/test';

export interface FakeRow {
	id: string;
	sport: string;
	title: string;
	/** Distance cell; "0 km" makes an indoor activity. Defaults to 5.00 km. */
	distance?: string;
}

/** Table rows for `rows`, shaped like the fixture's. */
export function fakeRowsHtml(rows: FakeRow[]): string {
	return rows
		.map(
			(r) =>
				`<tr><td>${r.sport}</td><td>Mon, 04/05/2026</td><td><a href="/activities/${r.id}">${r.title}</a></td>` +
				`<td class="num">30:00</td><td class="num">${r.distance ?? '5.00 km'}</td><td class="num">20 m</td><td class="num">5</td>` +
				`<td class="row-actions"><a href="#">Edit</a></td></tr>`,
		)
		.join('');
}

interface PagerOptions {
	/** How long a page takes to turn, in ms. */
	delayMs?: number;
	/** The total the pager claims - screenshots match the fixture's heading. */
	total?: number;
	/**
	 * Whether the table disappears while a page turns, as Strava's does.
	 * Screenshots keep it, so a mid-walk shot still shows a table.
	 */
	removeTable?: boolean;
}

/**
 * Add Strava's pager under the table - "21-40 of 60", ← and → - over
 * `pages` (each the HTML of a table body; '' keeps the fixture's rows),
 * starting on page `start`. Like Strava, turning a page takes the table out
 * for a moment, and the end arrows become disabled <span>s.
 */
export async function installFakePager(
	page: Page,
	pages: string[],
	start: number,
	{ delayMs = 50, total = pages.length * 20, removeTable = true }: PagerOptions = {},
): Promise<void> {
	await page.evaluate(
		({ pages, start, delayMs, total, removeTable }) => {
			const table = document.querySelector('table')!;
			const bodies = pages.map((html) => html || document.querySelector('tbody')!.innerHTML);
			const nav = document.createElement('div');
			nav.className = 'simple pagination';
			nav.style.cssText = 'display: flex; justify-content: center; align-items: center; gap: 12px; margin: 16px 0;';
			table.after(nav);
			let current = start;
			const arrow = (cls: string, enabled: boolean, label: string): string =>
				enabled
					? `<li><button class="btn next_or_prev ${cls}">${label}</button></li>`
					: `<li><span class="btn button disabled ${cls}">${label}</span></li>`;
			const render = (): void => {
				document.querySelector('tbody')!.innerHTML = bodies[current]!;
				nav.innerHTML =
					`<span class="pages"><b>${current * 20 + 1}-${current * 20 + 20}</b> of ${total}</span>` +
					`<ul class="switches" style="display: flex; gap: 6px; list-style: none; margin: 0; padding: 0;">` +
					`${arrow('previous_page', current > 0, '←')}${arrow('next_page', current < pages.length - 1, '→')}</ul>`;
			};
			nav.addEventListener('click', (e) => {
				const button = (e.target as Element).closest('button');
				if (!button) return;
				current += button.classList.contains('next_page') ? 1 : -1;
				const parent = table.parentElement!;
				const next = table.nextSibling;
				if (removeTable) table.remove();
				setTimeout(() => {
					if (removeTable) parent.insertBefore(table, next);
					render();
				}, delayMs);
			});
			render();
		},
		{ pages, start, delayMs, total, removeTable },
	);
	await page.locator('.pagination .pages').waitFor();
}
