// One zip being built, on fflate's streaming writer: each file is compressed
// as it's added and only the compressed bytes are kept, so a part's memory
// use is its zipped size rather than the size of the files in it.

import { Zip, ZipDeflate } from 'fflate';

export class ZipPart {
	/** Activity id → path inside the zip, for the CSV's File column. */
	readonly files = new Map<string, string>();
	/** Bytes of the files added so far, before compression. */
	bytes = 0;
	private readonly chunks: Uint8Array[] = [];
	private readonly zip: Zip;
	private error: Error | null = null;

	constructor() {
		this.zip = new Zip((err, chunk) => {
			if (err) this.error = err;
			else this.chunks.push(chunk);
		});
	}

	/**
	 * Add one file. Synchronous on purpose: callers decide which part a file
	 * goes into and add it without an `await` in between, so a part can't be
	 * closed while a file is on its way into it.
	 */
	add(path: string, data: Uint8Array): void {
		const entry = new ZipDeflate(path, { level: 6 });
		this.zip.add(entry);
		entry.push(data, true);
		this.bytes += data.byteLength;
	}

	/** Add an activity's file and remember where it went. */
	addActivity(id: string, path: string, data: Uint8Array): void {
		this.add(path, data);
		this.files.set(id, path);
	}

	/** Close the zip and return it. Throws if any entry failed to compress. */
	finish(): Blob {
		this.zip.end();
		if (this.error) throw this.error;
		return new Blob(this.chunks as BlobPart[], { type: 'application/zip' });
	}
}
