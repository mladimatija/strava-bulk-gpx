// Writing files straight into a folder the user picked (File System Access
// API), for backups too large to be comfortable as zips: nothing is held in
// memory beyond the file being written, and there are no downloads for
// Chrome to hold back.
//
// The folder handle comes from `showDirectoryPicker()`, which Chrome only
// opens from a click and which grants access to that one folder, for this
// page visit. No extension permission is involved.

/** `showDirectoryPicker` isn't in TypeScript's DOM library yet. */
type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

/** The browser's folder picker, or null where it doesn't exist (it's Chromium-only). */
export function directoryPicker(): DirectoryPicker | null {
	const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
	return typeof picker === 'function' ? picker.bind(globalThis) : null;
}

/** Split "Trail Run/1_title.gpx" into its folders and file name. */
function splitPath(path: string): { folders: string[]; name: string } {
	const folders = path.split('/');
	const name = folders.pop() ?? path;
	return { folders, name };
}

/** The folder a path's file lives in, created on the way when `create` is set; null if it doesn't exist. */
async function folderOf(
	dir: FileSystemDirectoryHandle,
	folders: string[],
	create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
	let folder = dir;
	for (const segment of folders) {
		try {
			folder = await folder.getDirectoryHandle(segment, { create });
		} catch (e) {
			if (!create && e instanceof DOMException && e.name === 'NotFoundError') return null;
			throw e;
		}
	}
	return folder;
}

/** Size in bytes of the file at `path` under `dir`, or null when there's none. */
export async function existingSize(dir: FileSystemDirectoryHandle, path: string): Promise<number | null> {
	const { folders, name } = splitPath(path);
	const folder = await folderOf(dir, folders, false);
	if (!folder) return null;
	try {
		return (await (await folder.getFileHandle(name)).getFile()).size;
	} catch (e) {
		if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
		throw e;
	}
}

/** Write `data` to `path` under `dir`, creating folders on the way and replacing a file already there. */
export async function writeFile(
	dir: FileSystemDirectoryHandle,
	path: string,
	data: Uint8Array | string,
): Promise<void> {
	const { folders, name } = splitPath(path);
	const folder = (await folderOf(dir, folders, true))!;
	const file = await folder.getFileHandle(name, { create: true });
	const writable = await file.createWritable();
	try {
		await writable.write(data as FileSystemWriteChunkType);
		await writable.close();
	} catch (e) {
		// Leave no half-written file behind.
		await writable.abort().catch(() => undefined);
		throw e;
	}
}
