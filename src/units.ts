// Lengths for the custom Hide start/end distance, in the unit and number
// format of the browser's locale.

/** A custom Hide start/end distance's unit. */
export type LengthUnit = 'm' | 'ft';

export const METRES_PER_FOOT = 0.3048;

/**
 * The unit a custom distance starts in: feet where `locale` measures in feet
 * (the US, Liberia, Myanmar - "en" alone means en-US), metres everywhere
 * else.
 */
export function defaultLengthUnit(locale: string): LengthUnit {
	try {
		const region = new Intl.Locale(locale).maximize().region;
		return region === 'US' || region === 'LR' || region === 'MM' ? 'ft' : 'm';
	} catch {
		return 'm';
	}
}

function unitFormat(unit: LengthUnit, locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
	const style = { style: 'unit', unit: unit === 'ft' ? 'foot' : 'meter', unitDisplay: 'short' } as const;
	return new Intl.NumberFormat(locale, { ...style, ...options });
}

/** "650 ft", "1.200 m" - a length as `locale` writes it. */
export function lengthLabel(value: number, unit: LengthUnit, locale: string): string {
	return unitFormat(unit, locale, { maximumFractionDigits: 2 }).format(value);
}

/** The unit's own abbreviation in `locale` ("m", "ft"), for the unit dropdown. */
export function unitName(unit: LengthUnit, locale: string): string {
	return (
		unitFormat(unit, locale)
			.formatToParts(1)
			.find((part) => part.type === 'unit')?.value ?? unit
	);
}
