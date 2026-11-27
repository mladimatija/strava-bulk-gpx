// Reading a table cell as a distance, whatever unit and language Strava
// shows it in: "48.11 km", "30.5 mi", "1,500 m" (swims), "1 650 yd",
// "10,07 км". Kept free of DOM access so it runs under `node --test`.

/**
 * Whether `text` reads as a distance - a number followed by a unit - and if
 * so, whether it's more than zero. Null when the cell isn't a distance:
 * times ("46:22"), dates, bare numbers and free text.
 *
 * The unit is any run of letters rather than a list of known ones: Strava
 * shows swims in metres or yards, and translates units on localized pages.
 */
export function distanceShown(text: string): boolean | null {
	const m = /^(\d[\d.,\s'’]*?)\s*\p{L}[\p{L}.]*$/u.exec(text.trim());
	if (!m?.[1]) return null;
	// Thousands and decimal separators vary by locale, but any non-zero
	// digit means a positive distance.
	return /[1-9]/.test(m[1]);
}
