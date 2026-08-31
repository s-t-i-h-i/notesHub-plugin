import { App, normalizePath, TFile, TFolder } from 'obsidian';
import JSZip from 'jszip';
import { DEFAULT_SETTINGS } from './settings';
import {
	ALLOWED_EXTENSIONS,
	MAX_ARCHIVE_BYTES,
	MAX_ENTRIES,
	MAX_ENTRY_DEPTH,
	MAX_ENTRY_PATH,
	MAX_FOLDER_NAME,
	MAX_COMPRESSION_RATIO,
	MAX_UNCOMPRESSED_BYTES,
} from './constants';
import { extensionOf, isScannable, scanContent, type Finding } from './scan';

/**
 * Characters not allowed in a folder name.
 *
 * The first group (\ / : * ? " < > |) would fail at the filesystem level;
 * the second (# ^ [ ]) would work but breaks Obsidian's link syntax.
 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/**
 * Control characters and NUL — these truncate a path at the OS level.
 * no-control-regex is disabled deliberately: these characters are exactly
 * what this pattern checks for, not a mistake.
 */
// eslint-disable-next-line no-control-regex -- these characters are intentional here, not a typo
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Text-direction override characters (U+202E and friends). A filename
 * containing RLO displays with its ending reversed, disguising the real
 * extension.
 */
const BIDI_CHARS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/;

/**
 * Global (/g) versions, used only for cleaning up the title.
 *
 * Kept separate on purpose: `test()` on a /g regex is stateful (it
 * remembers `lastIndex` between calls), so reusing the same pattern for
 * both `test()` and `replace()` would make every other check on the same
 * name pass falsely.
 */
const CONTROL_CHARS_ALL = new RegExp(CONTROL_CHARS.source, 'g');
const BIDI_CHARS_ALL = new RegExp(BIDI_CHARS.source, 'g');

/** Reserved DOS device names — Windows refuses to create a file with one of these, even with an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** How many numbered suffixes to try on a taken name before giving up. */
const MAX_NAME_ATTEMPTS = 100;

/** An archive entry whose path has already passed validation. */
interface PlannedFile {
	/** Path relative to the package folder, e.g. "images/diagram.png". */
	path: string;
	entry: JSZip.JSZipObject;
}

/** A validated archive, ready to be written. */
export interface PackagePlan {
	files: PlannedFile[];
	/** Active content found in the files — shown to the user BEFORE anything is written. */
	findings: Finding[];
	/** Unpacked size, as declared by the archive. */
	totalBytes: number;
}

/**
 * Validates an archive and builds the list of files to write.
 *
 * Kept separate from writing on purpose: a downloaded package is someone
 * else's notes, so the user gets to see what's inside before anything lands
 * in their vault. This function itself writes nothing.
 */
export async function inspectArchive(archive: ArrayBuffer): Promise<PackagePlan> {
	if (archive.byteLength === 0) {
		throw new Error('The downloaded file is empty');
	}
	if (archive.byteLength > MAX_ARCHIVE_BYTES) {
		throw new Error(
			`The archive is ${formatBytes(archive.byteLength)}, the limit is ${formatBytes(MAX_ARCHIVE_BYTES)}`,
		);
	}
	// Check the magic bytes before handing this to JSZip: the server is
	// public, so its response is just bytes, and without this the user saw
	// a raw JSZip error instead of a clear message.
	if (!hasZipMagic(new Uint8Array(archive))) {
		throw new Error('The downloaded file is not a ZIP archive');
	}

	const zip = await JSZip.loadAsync(archive);

	// Validate the whole archive before writing a single byte. It's all
	// string and metadata checks, and it guarantees "all or nothing".
	const files = planFiles(zip);
	if (files.length === 0) {
		throw new Error('The archive contains no files');
	}

	const totalBytes = assertUnpackedSize(files, archive.byteLength);
	const findings = await scanFiles(files);

	return { files, findings, totalBytes };
}

/**
 * Writes a validated package to the vault and returns the created folder's
 * path. The caller uses it for the confirmation message and to open the note.
 */
export async function installPlan(
	app: App,
	plan: PackagePlan,
	baseFolder: string,
	packageTitle: string,
): Promise<string> {
	const root = await createPackageFolder(app, baseFolder, packageTitle);

	try {
		await writeFiles(app, root, plan.files);
	} catch (error) {
		// A half-written package is worse than no package.
		await rollback(app, root);
		throw error;
	}

	return root;
}

/**
 * What writing one archive entry over an installed package would do.
 *
 * `identical` is not an optimization: sync tools (Obsidian Sync, Dropbox,
 * iCloud, git) touch mtime without changing content, so without a byte
 * comparison first the mtime check below would call the whole package
 * locally modified and trash every file on every update.
 */
type FileStatus = 'new' | 'identical' | 'changed' | 'modified';

interface PlannedWrite {
	file: PlannedFile;
	status: FileStatus;
	existing: TFile | null;
	data: ArrayBuffer;
}

/** A validated archive matched against the folder it will be written over. */
export interface UpdatePlan {
	root: string;
	writes: PlannedWrite[];
}

/**
 * Works out what updating an installed package would change. Writes nothing.
 *
 * `installedAt` is the timestamp recorded after the last install, so a file
 * whose content differs AND whose mtime is newer was edited by the user.
 *
 * ponytail: mtime is a heuristic, exact only to the filesystem's timestamp
 * resolution — an edit made in the same tick as the install reads as
 * untouched. Byte comparison covers the common false positive; per-file
 * hashes in the install record would be the upgrade if the rest ever bites.
 */
export async function planUpdate(
	app: App,
	plan: PackagePlan,
	root: string,
	installedAt: number,
): Promise<UpdatePlan> {
	assertInsideVault(root);

	// One case-insensitive index instead of getAbstractFileByPath() per file:
	// that lookup is case-sensitive while macOS and Windows are not, so an
	// archive holding "Note.md" over a vault holding "note.md" would look
	// like a new file and then collide at the filesystem level mid-write.
	const existingFiles = indexFolder(app, root);
	const writes: PlannedWrite[] = [];

	for (const file of plan.files) {
		const data = await file.entry.async('arraybuffer');
		const existing = existingFiles.get(file.path.toLowerCase()) ?? null;

		if (existing === null) {
			writes.push({ file, status: 'new', existing, data });
			continue;
		}

		const current = await app.vault.readBinary(existing);
		if (sameBytes(current, data)) {
			writes.push({ file, status: 'identical', existing, data });
			continue;
		}

		const status = existing.stat.mtime > installedAt ? 'modified' : 'changed';
		writes.push({ file, status, existing, data });
	}

	return { root, writes };
}

/**
 * Writes an update over an installed package.
 *
 * Deliberately no rollback(): that trashes the whole root folder, which here
 * would take the user's own notes with it. A half-applied update is instead
 * made safe by being repeatable — the caller must not advance the install
 * record unless this resolves, so pressing Update again replays the same
 * plan, skips everything already written, and finishes the rest.
 */
export async function applyUpdate(app: App, update: UpdatePlan): Promise<void> {
	const folders = new Set<string>([update.root]);

	for (const write of update.writes) {
		// Already byte-identical — writing it would only churn mtime and make
		// the next update think the user had touched it.
		if (write.status === 'identical') continue;

		const path = `${update.root}/${write.file.path}`;
		await ensureFolder(app, path.slice(0, path.lastIndexOf('/')), folders);

		if (write.existing === null) {
			await app.vault.createBinary(path, write.data);
			continue;
		}

		// The user's version goes to the trash rather than under the new
		// bytes: an update is not allowed to destroy an edit outright.
		if (write.status === 'modified') {
			await app.fileManager.trashFile(write.existing);
			await app.vault.createBinary(path, write.data);
			continue;
		}

		await app.vault.modifyBinary(write.existing, write.data);
	}
}

/**
 * Resolves an install record to the folder it names, or null if it no longer
 * holds.
 *
 * This is a security gate, not just a staleness check: the path comes from
 * data.json, which is hand-editable, and it is a write target. Obsidian's
 * index only contains real in-vault paths, so anything with ".." in it
 * simply doesn't resolve — normalizePath() would not have stripped it.
 */
export function resolveInstall(app: App, path: string): TFolder | null {
	const folder = app.vault.getAbstractFileByPath(normalizePath(path));
	return folder instanceof TFolder ? folder : null;
}

/** Maps every file under `root` by its lowercased path relative to root. */
function indexFolder(app: App, root: string): Map<string, TFile> {
	const files = new Map<string, TFile>();
	const folder = app.vault.getAbstractFileByPath(root);
	if (!(folder instanceof TFolder)) return files;

	const prefix = `${root}/`;
	const walk = (current: TFolder): void => {
		for (const child of current.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile) files.set(child.path.slice(prefix.length).toLowerCase(), child);
		}
	};
	walk(folder);

	return files;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;

	const left = new Uint8Array(a);
	const right = new Uint8Array(b);
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}

	return true;
}

/** PK\x03\x04 for a normal archive, PK\x05\x06 for an empty one. */
function hasZipMagic(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	return (
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
	);
}

/**
 * Turns archive entries into a list of files to write.
 *
 * Throws on the first suspicious path — the whole archive is rejected
 * rather than silently skipping one entry. A path that escapes the target
 * folder is an attack, not a typo.
 */
function planFiles(zip: JSZip): PlannedFile[] {
	const files: PlannedFile[] = [];
	const seen = new Set<string>();

	for (const entry of Object.values(zip.files)) {
		// Folders are rebuilt from file paths — a ZIP isn't required to have
		// directory entries, so we can't rely on them anyway.
		if (entry.dir) continue;

		if (files.length >= MAX_ENTRIES) {
			throw new Error(`The archive contains more than ${MAX_ENTRIES} files`);
		}

		const path = safeRelativePath(entry.name);

		// macOS and Windows are case-insensitive, so "A.md" and "a.md" are
		// the same file there — the second write would fail mid-install.
		const key = path.toLowerCase();
		if (seen.has(key)) {
			throw new Error(`Duplicate path in archive: ${entry.name}`);
		}
		seen.add(key);

		files.push({ path, entry });
	}

	return files;
}

/**
 * Checks whether an archive path is safe and worth keeping.
 *
 * One pass over the segments catches every kind of path escape: ".." goes
 * up a level, an empty segment means a leading slash (absolute path) or a
 * doubled "//", and "." is just clutter.
 */
export function safeRelativePath(name: string): string {
	// Some zip tools write the Windows separator; we won't guess whether
	// "a\b.md" is one filename or two path segments.
	if (name.includes('\\')) {
		throw new Error(`Disallowed path in archive: ${name}`);
	}
	if (name.length > MAX_ENTRY_PATH) {
		throw new Error(`Path too long in archive: ${name.slice(0, 60)}...`);
	}
	if (CONTROL_CHARS.test(name)) {
		throw new Error('Control characters in archive path');
	}
	if (BIDI_CHARS.test(name)) {
		// Not cosmetic: a file like this shows a different extension in the
		// file explorer than it actually has.
		throw new Error('Text-direction control characters in archive path');
	}

	const segments = name.split('/');
	if (segments.length > MAX_ENTRY_DEPTH) {
		throw new Error(`Nesting too deep in archive (${segments.length} levels)`);
	}

	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') {
			throw new Error(`Disallowed path in archive: ${name}`);
		}
		// A leading dot hides the file from Obsidian's file explorer — a
		// package has no reason to smuggle in invisible content.
		if (segment.startsWith('.')) {
			throw new Error(`Hidden file or folder in archive: ${name}`);
		}
		// Windows silently strips a trailing dot or space, so "note .md" and
		// "note.md" become the same file — a collision waiting to happen
		// mid-write.
		if (/[. ]$/.test(segment)) {
			throw new Error(`Name ending in a dot or space: ${name}`);
		}
		if (WINDOWS_RESERVED.test(segment)) {
			throw new Error(`Reserved system name in archive: ${segment}`);
		}
	}

	// Same extension list used when publishing. Without this, installing a
	// package could write .js, .exe, or extensionless files to the vault,
	// even though only notes and images could ever be packed.
	const extension = extensionOf(name);
	if (!ALLOWED_EXTENSIONS.includes(extension)) {
		throw new Error(
			`Disallowed file type in archive: ${name}` +
				(extension ? ` (.${extension})` : ' (no extension)'),
		);
	}

	return segments.join('/');
}

/**
 * Checks the unpacked size using the sizes declared in the archive.
 *
 * This is the only point where a zip bomb can still be stopped — after
 * calling `async()` the data is already in memory. A 204 KB archive can
 * declare 200 MB of content.
 *
 * `_data` is a JSZip internal field, read defensively: if a future JSZip
 * version renames it, the file-count limit still catches abuse.
 */
function assertUnpackedSize(files: PlannedFile[], archiveBytes: number): number {
	let total = 0;

	for (const file of files) {
		const data = (file.entry as unknown as { _data?: { uncompressedSize?: number } })._data;
		total += typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0;
	}

	if (total > MAX_UNCOMPRESSED_BYTES) {
		throw new Error(
			`Unpacked, the package would take up ${formatBytes(total)}, the limit is ${formatBytes(MAX_UNCOMPRESSED_BYTES)}`,
		);
	}

	// The size cap alone isn't enough — a tiny archive just under it is still a bomb.
	if (total > MAX_COMPRESSION_RATIO * archiveBytes) {
		throw new Error(
			`Suspicious compression ratio: a ${formatBytes(archiveBytes)} archive unpacks to ${formatBytes(total)}`,
		);
	}

	return total;
}

/** Reads text files from the archive and scans them for active content. */
async function scanFiles(files: PlannedFile[]): Promise<Finding[]> {
	const findings: Finding[] = [];

	for (const file of files) {
		if (!isScannable(file.path)) continue;
		findings.push(...scanContent(file.path, await file.entry.async('string')));
	}

	return findings;
}

/** Creates an empty folder for the package and returns its path. */
async function createPackageFolder(
	app: App,
	baseFolder: string,
	packageTitle: string,
): Promise<string> {
	// An empty setting shouldn't mean "dump the package into the vault root".
	const base = normalizePath(baseFolder.trim() || DEFAULT_SETTINGS.downloadFolder);
	assertInsideVault(base);

	const folders = new Set<string>();
	await ensureFolder(app, base, folders);

	const name = toFolderName(packageTitle);
	for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
		// "Package", "Package 2", "Package 3"... — downloading the same
		// package twice should create a second folder, not fail.
		const suffix = attempt === 1 ? '' : ` ${attempt}`;
		const path = normalizePath(`${base}/${name}${suffix}`);

		if (app.vault.getAbstractFileByPath(path) === null) {
			await app.vault.createFolder(path);
			return path;
		}
	}

	throw new Error(`Could not find a free folder name for "${packageTitle}"`);
}

/**
 * Turns a package title into a folder name.
 *
 * The title is free-form user input from the publish form, so it can
 * contain anything — including characters that break a path or create a
 * hidden folder. Also truncated: filesystems cap path segments around 255
 * bytes, and the server used to accept titles up to 200,000 characters long.
 */
function toFolderName(title: string): string {
	const name = title
		.replace(CONTROL_CHARS_ALL, '')
		.replace(BIDI_CHARS_ALL, '')
		.replace(ILLEGAL_NAME_CHARS, '-')
		// a leading dot hides the folder from Obsidian, a trailing one breaks paths on Windows
		.replace(/^[.\s]+|[.\s]+$/g, '')
		.slice(0, MAX_FOLDER_NAME)
		// truncation may have exposed another trailing dot or space
		.replace(/[.\s]+$/g, '');

	if (!name) return 'package';
	return WINDOWS_RESERVED.test(name) ? `package ${name}` : name;
}

/** normalizePath() cleans up slashes but leaves ".." alone — and that can escape the vault. */
function assertInsideVault(path: string): void {
	if (path.split('/').some((segment) => segment === '..')) {
		throw new Error(`Disallowed destination folder: ${path}`);
	}
}

/** Writes the planned files, creating any missing subfolders along the way. */
async function writeFiles(app: App, root: string, files: PlannedFile[]): Promise<void> {
	// Track folders already created: createFolder() throws if the folder
	// exists, and every other file in the same subfolder would hit this again.
	const folders = new Set<string>([root]);

	for (const file of files) {
		const path = `${root}/${file.path}`;
		await ensureFolder(app, path.slice(0, path.lastIndexOf('/')), folders);

		// createBinary() writes raw bytes, so it handles .md and images
		// alike — one code path instead of branching on extension.
		await app.vault.createBinary(path, await file.entry.async('arraybuffer'));
	}
}

/** Creates a folder along with any missing parent folders, root-down. */
async function ensureFolder(app: App, path: string, folders: Set<string>): Promise<void> {
	let current = '';

	for (const segment of path.split('/')) {
		current = current ? `${current}/${segment}` : segment;

		if (folders.has(current)) continue;
		if (app.vault.getAbstractFileByPath(current) === null) {
			await app.vault.createFolder(current);
		}

		folders.add(current);
	}
}

/**
 * Cleans up after a failed install.
 *
 * The folder goes to the trash, not permanent deletion — if validation ever
 * false-positives, the user can still get their files back.
 */
async function rollback(app: App, root: string): Promise<void> {
	const folder = app.vault.getAbstractFileByPath(root);
	if (folder === null) return;

	try {
		await app.fileManager.trashFile(folder);
	} catch (error) {
		console.error('Failed to clean up after a failed installation', error);
	}
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
	return `${bytes} B`;
}
