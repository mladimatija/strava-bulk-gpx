// Activity dates from the text of Strava's Date column, for date-based file
// names and the CSV's ISO date column.
//
// The column is plain text in the athlete's display format - "Tue, 17/11/2026"
// day-first, "Tue, 11/17/2026" month-first, "2026/11/17" year-first - with no
// machine-readable attribute. Year-first is unambiguous. For the other two,
// a day above 12 settles it, and so does the weekday name when only one
// reading falls on that weekday. The table uses one format throughout, so
// once any row settles the order, it applies to the rows that can't.

/** Which of day and month comes first in a date that isn't year-first. */
export type DateOrder = 'dmy' | 'mdy';

interface Resolved {
	/** The date as YYYY-MM-DD, or null when it can't be told. */
	iso: string | null;
	/** The order this text proves on its own, if any. */
	order: DateOrder | null;
	/** Both readings, when the text alone can't choose between them. */
	readings?: Record<DateOrder, string>;
}

/** YYYY-MM-DD for a real calendar date, else null (so 31/02 is rejected). */
function isoOf(year: number, month: number, day: number): string | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.toISOString().slice(0, 10);
}

/** Lower-case letters only, so "Tue," and "mar." compare as "tue" and "mar". */
function letters(text: string): string {
	return text.toLocaleLowerCase().replace(/[^\p{L}]/gu, '');
}

/**
 * Whether the weekday word in `text` names the weekday of `iso` in `locale`
 * (short or long form). False when there's no weekday word to compare.
 */
function weekdayMatches(text: string, iso: string, locale: string): boolean {
	const word = letters(/\p{L}+/u.exec(text)?.[0] ?? '');
	if (word.length < 2) return false;
	const date = new Date(`${iso}T12:00:00Z`);
	return (['short', 'long'] as const).some((weekday) => {
		const name = letters(new Intl.DateTimeFormat(locale, { weekday, timeZone: 'UTC' }).format(date));
		return name.length >= 2 && (name.startsWith(word) || word.startsWith(name));
	});
}

function resolve(text: string, locale: string): Resolved {
	const nums = text.match(/\d+/g);
	if (!nums || nums.length < 3) return { iso: null, order: null };
	const [a, b, c] = nums.slice(0, 3) as [string, string, string];
	if (a.length === 4) return { iso: isoOf(Number(a), Number(b), Number(c)), order: null };
	if (c.length !== 4) return { iso: null, order: null };

	const dmy = isoOf(Number(c), Number(b), Number(a));
	const mdy = isoOf(Number(c), Number(a), Number(b));
	if (dmy === mdy) return { iso: dmy, order: null };
	if (!mdy) return { iso: dmy, order: 'dmy' };
	if (!dmy) return { iso: mdy, order: 'mdy' };
	const dmyDay = weekdayMatches(text, dmy, locale);
	const mdyDay = weekdayMatches(text, mdy, locale);
	if (dmyDay !== mdyDay) return dmyDay ? { iso: dmy, order: 'dmy' } : { iso: mdy, order: 'mdy' };
	return { iso: null, order: null, readings: { dmy, mdy } };
}

/** The day/month order `text` proves on its own, or null. */
export function dateOrderOf(text: string, locale: string): DateOrder | null {
	return resolve(text, locale).order;
}

/**
 * The date in `text` as YYYY-MM-DD. When the text alone is ambiguous,
 * `order` (learned from other rows) decides; without it, null.
 */
export function isoDate(text: string, locale: string, order: DateOrder | null): string | null {
	const { iso, readings } = resolve(text, locale);
	return iso ?? (readings && order ? readings[order] : null);
}
