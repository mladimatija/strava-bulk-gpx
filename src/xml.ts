// Small DOM helpers shared by the GPX/TCX merge (downloader.ts) and the GPX
// trimmer (trim.ts).

/** Direct children of `parent` with the given local name, whatever their namespace prefix. */
export function childrenNamed(parent: Element, localName: string): Element[] {
	return Array.from(parent.children).filter((el) => el.localName === localName);
}

/** Serialize an XML document with the declaration XMLSerializer leaves out. */
export function serializeXml(doc: Document): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
}
