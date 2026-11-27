// Unit tests for writing into a picked folder (folder.ts), against an
// in-memory stand-in for the File System Access API's directory handle.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existingSize, writeFile } from '../../src/folder.ts';

/** An in-memory directory: just enough of FileSystemDirectoryHandle for folder.ts. */
class FakeDir {
	readonly dirs = new Map<string, FakeDir>();
	readonly files = new Map<string, Uint8Array>();
	/** Names whose writes fail part-way, to exercise the abort path. */
	readonly failing = new Set<string>();
	aborted = 0;

	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
		let dir = this.dirs.get(name);
		if (!dir) {
			if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError'));
			dir = new FakeDir();
			this.dirs.set(name, dir);
		}
		return Promise.resolve(dir);
	}

	getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown> {
		if (this.dirs.has(name)) return Promise.reject(new DOMException('a folder', 'TypeMismatchError'));
		if (!this.files.has(name)) {
			if (!options?.create) return Promise.reject(new DOMException('missing', 'NotFoundError'));
			this.files.set(name, new Uint8Array());
		}
		return Promise.resolve({
			getFile: () => Promise.resolve({ size: this.files.get(name)!.byteLength }),
			createWritable: () => {
				let written: Uint8Array = new Uint8Array();
				return Promise.resolve({
					write: (data: Uint8Array | string) => {
						if (this.failing.has(name)) return Promise.reject(new Error('disk full'));
						written = typeof data === 'string' ? new TextEncoder().encode(data) : data;
						return Promise.resolve();
					},
					close: () => {
						this.files.set(name, written);
						return Promise.resolve();
					},
					abort: () => {
						this.aborted++;
						return Promise.resolve();
					},
				});
			},
		});
	}
}

const handle = (dir: FakeDir): FileSystemDirectoryHandle => dir as unknown as FileSystemDirectoryHandle;

void test('a file is written where its path says, creating folders on the way', async () => {
	const root = new FakeDir();
	await writeFile(handle(root), 'strava_1.gpx', new Uint8Array([1, 2, 3]));
	await writeFile(handle(root), 'Trail Run/2_Lunch.gpx', new Uint8Array([4, 5]));
	await writeFile(handle(root), 'strava_activities_2026-05-06.csv', 'id\r\n1\r\n');
	assert.deepEqual(root.files.get('strava_1.gpx'), new Uint8Array([1, 2, 3]));
	assert.deepEqual(root.dirs.get('Trail Run')?.files.get('2_Lunch.gpx'), new Uint8Array([4, 5]));
	assert.equal(root.files.get('strava_activities_2026-05-06.csv')?.byteLength, 7);
});

void test('writing again replaces the file', async () => {
	const root = new FakeDir();
	await writeFile(handle(root), 'a.gpx', new Uint8Array([1, 2, 3]));
	await writeFile(handle(root), 'a.gpx', new Uint8Array([9]));
	assert.deepEqual(root.files.get('a.gpx'), new Uint8Array([9]));
});

void test('existing files report their size; missing files and folders report none', async () => {
	const root = new FakeDir();
	await writeFile(handle(root), 'Run/a.gpx', new Uint8Array(7));
	assert.equal(await existingSize(handle(root), 'Run/a.gpx'), 7);
	assert.equal(await existingSize(handle(root), 'Run/b.gpx'), null);
	assert.equal(await existingSize(handle(root), 'Ride/a.gpx'), null);
	assert.equal(await existingSize(handle(root), 'Run'), null);
	// Looking doesn't create anything.
	assert.deepEqual([...root.dirs.keys()], ['Run']);
});

void test('a failed write is aborted and reported', async () => {
	const root = new FakeDir();
	root.failing.add('a.gpx');
	await assert.rejects(writeFile(handle(root), 'a.gpx', new Uint8Array([1])), /disk full/);
	assert.equal(root.aborted, 1);
});
