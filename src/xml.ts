// Small DOM helpers shared by the GPX/TCX merge (downloader.ts) and the
// GPX/TCX trimmer (trim.ts).

export const GPX_NS = 'http://www.topografix.com/GPX/1/1';
export const TCX_NS = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';

/** Direct children of `parent` with the given local name, whatever their namespace prefix. */
export function childrenNamed(parent: Element, localName: string): Element[] {
	return Array.from(parent.children).filter((el) => el.localName === localName);
}

/**
 * Serialize an XML document with exactly one UTF-8 declaration. XMLSerializer
 * keeps the declaration of a document parsed from text that had one (every
 * Strava export does) and has none otherwise, so drop whatever it wrote and
 * add ours - two declarations make the file malformed.
 */
export function serializeXml(doc: Document): string {
	const body = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^?]*\?>\s*/, '');
	return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
