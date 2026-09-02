import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { DEFAULT_SETTINGS } from './settings';
import {
	ALLOWED_EXTENSIONS,
	MAX_ARCHIVE_BYTES,
	MAX_ENTRIES,
	MAX_ENTRY_BYTES,
	MAX_ENTRY_DEPTH,
	MAX_ENTRY_PATH,
	MAX_FOLDER_NAME,
	MAX_COMPRESSION_RATIO,
	MAX_UNCOMPRESSED_BYTES,
} from './constants';
import { readTarGz, assertSafeEntryName, type TarEntry } from './tar';
import { assertContentMatchesExtension, extensionOf } from './verify';
import { arm, armCanvas, disarm, disarmCanvas } from './disarm';
import type { Capability, Finding } from './policy/types';

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

/**
 * Capabilities toWrite() is supposed to neutralise.
 *
 * Everything else the manifest reports on a 'render' trigger — a remote image,
 * a DQL query — is deliberately left running, so counting those would turn the
 * check below into noise nobody reads.
 */
const DISARMED_CAPABILITIES: Capability[] = ['js', 'remote-embed'];

/** A validated archive, ready to be written. */
export interface PackagePlan {
	/** Paths relative to the package folder, e.g. "images/diagram.png". */
	paths: string[];
	/** Unpacked size of the whole package. */
	totalBytes: number;
	/**
	 * Files the server says start on their own that we did NOT switch off.
	 *
	 * The install screen used to state flatly that anything self-starting is
	 * installed switched off. Nothing checked whether that was true for the
	 * package in hand, so a construct disarm() did not know about — a canvas, a
	 * fence language it skipped — shipped live under a reassuring sentence. The
	 * manifest is an independent witness here: it is computed by the server from
	 * the same bytes, by code that is not the code being checked.
	 */
	stillArmed: string[];
}

/**
 * Validates an archive and works out what it holds. Writes nothing.
 *
 * No decompressed bytes are kept. A confirmation screen can sit open for as
 * long as the reader likes, and pinning the unpacked package would hold up to
 * MAX_UNCOMPRESSED_BYTES the whole time — so every later step re-reads the
 * archive instead, which costs one gzip pass and no memory.
 *
 * What this does NOT do is describe the package again. The server already did
 * that on these exact bytes — sha256 was checked before this was called — with
 * the same code, so a second pass could only ever agree with itself.
 *
 * What stays is the path checking, and it stays for a different reason than
 * distrust of the server: it is the last thing between an archive and
 * vault.createBinary(). The cost is a scan over a string and the failure it
 * prevents is writing outside the vault, so it is worth keeping whoever else
 * has already looked.
 */
export async function inspectArchive(archive: ArrayBuffer, findings: Finding[] = []): Promise<PackagePlan> {
	if (archive.byteLength === 0) throw new Error('The downloaded file is empty');
	if (archive.byteLength > MAX_ARCHIVE_BYTES) {
		throw new Error(
			`The archive is ${formatBytes(archive.byteLength)}, the limit is ${formatBytes(MAX_ARCHIVE_BYTES)}`,
		);
	}

	const paths: string[] = [];
	const seen = new Set<string>();
	const stillArmed: string[] = [];
	const selfStarting = new Set(
		findings
			.filter((found) => found.trigger === 'render' && found.capabilities.some((c) => DISARMED_CAPABILITIES.includes(c)))
			.map((found) => found.path),
	);
	let totalBytes = 0;

	await eachEntryAsync(archive, async (entry) => {
		const path = safeRelativePath(entry.name);

		// macOS and Windows are case-insensitive, so "A.md" and "a.md" are the
		// same file there — the second write would fail mid-install.
		const key = path.toLowerCase();
		if (seen.has(key)) throw new Error(`Duplicate path in archive: ${entry.name}`);
		seen.add(key);

		assertContentMatchesExtension(path, entry.data);

		// toWrite() hands back the very same array when it changed nothing, so
		// identity is the answer to "did we switch anything off in this file".
		if (selfStarting.has(entry.name) && toWrite(entry) === entry.data) stillArmed.push(path);

		paths.push(path);
		totalBytes += entry.data.length;
	});

	if (paths.length === 0) throw new Error('The archive contains no files');

	return { paths, totalBytes, stillArmed };
}

/**
 * Writes a validated package to the vault and returns the created folder's
 * path. The caller uses it for the confirmation message and to open the note.
 */
export async function installPlan(
	app: App,
	archive: ArrayBuffer,
	packageTitle: string,
	baseFolder: string,
): Promise<string> {
	const root = await createPackageFolder(app, baseFolder, packageTitle);

	try {
		const folders = new Set<string>([root]);
		await eachEntryAsync(archive, async (entry) => {
			const path = `${root}/${safeRelativePath(entry.name)}`;
			await ensureFolder(app, path.slice(0, path.lastIndexOf('/')), folders);
			await app.vault.createBinary(path, toWrite(entry).buffer as ArrayBuffer);
		});
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
	path: string;
	status: FileStatus;
	existing: TFile | null;
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
 * whose content differs AND whose mtime is newer was edited by the reader.
 *
 * ponytail: mtime is a heuristic, exact only to the filesystem's timestamp
 * resolution — an edit made in the same tick as the install reads as
 * untouched. Byte comparison covers the common false positive; per-file
 * hashes in the install record would be the upgrade if the rest ever bites.
 */
export async function planUpdate(
	app: App,
	archive: ArrayBuffer,
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

	await eachEntryAsync(archive, async (entry) => {
		const path = safeRelativePath(entry.name);
		const existing = existingFiles.get(path.toLowerCase()) ?? null;

		if (existing === null) {
			writes.push({ path, status: 'new', existing });
			return;
		}

		// Both buffers fall out of scope at the end of the call, so the
		// comparison costs two files' worth of memory, not the whole package.
		const current = await app.vault.readBinary(existing);
		writes.push({ path, status: compare(path, current, entry, existing.stat.mtime > installedAt), existing });
	});

	return { root, writes };
}

/**
 * Writes an update over an installed package.
 *
 * Deliberately no rollback(): that trashes the whole root folder, which here
 * would take the reader's own notes with it. A half-applied update is instead
 * made safe by being repeatable — the caller must not advance the install
 * record unless this resolves, so pressing Update again replays the same
 * plan, skips everything already written, and finishes the rest.
 */
export async function applyUpdate(app: App, archive: ArrayBuffer, update: UpdatePlan): Promise<void> {
	const folders = new Set<string>([update.root]);
	const planned = new Map(update.writes.map((write) => [write.path, write]));

	await eachEntryAsync(archive, async (entry) => {
		const write = planned.get(safeRelativePath(entry.name));
		// Already byte-identical, or switched on by the reader — writing it
		// would only churn mtime and undo their choice.
		if (write === undefined || write.status === 'identical') return;

		const path = `${update.root}/${write.path}`;
		await ensureFolder(app, path.slice(0, path.lastIndexOf('/')), folders);

		const data = toWrite(entry).buffer as ArrayBuffer;

		if (write.existing === null) {
			await app.vault.createBinary(path, data);
			return;
		}

		// The reader's version goes to the trash rather than under the new
		// bytes: an update is not allowed to destroy an edit outright.
		if (write.status === 'modified') {
			await app.fileManager.trashFile(write.existing);
			await app.vault.createBinary(path, data);
			return;
		}

		await app.vault.modifyBinary(write.existing, data);
	});
}

/**
 * What a file becomes on disk.
 *
 * Notes are written switched off: anything that would run the moment the note
 * is opened is suffixed so no interpreter matches it. The code stays in the
 * file, visible and unchanged, and the reader switches it on when they choose.
 */
function toWrite(entry: TarEntry): Uint8Array {
	const extension = extensionOf(entry.name);
	// A canvas renders its text nodes exactly like a note, so it needs the same
	// treatment — through its own JSON, which plain disarm() cannot see into.
	if (extension !== 'md' && extension !== 'canvas') return entry.data;

	const text = new TextDecoder().decode(entry.data);
	const off = extension === 'canvas' ? disarmCanvas(text) : disarm(text);

	return off === text ? entry.data : new TextEncoder().encode(off);
}

/**
 * How an installed file compares to the archive.
 *
 * For notes the comparison is made with everything switched back on, so a
 * block the reader chose to enable does not read as an accidental edit — which
 * would otherwise send their file to the trash on the next update.
 */
function compare(path: string, current: ArrayBuffer, entry: TarEntry, touched: boolean): FileStatus {
	const wanted = toWrite(entry);
	if (sameBytes(current, wanted)) return 'identical';

	const extension = extensionOf(path);
	if (extension === 'md' || extension === 'canvas') {
		const decoder = new TextDecoder();
		try {
			const armed = extension === 'canvas' ? canvasKey : arm;
			if (armed(decoder.decode(current)) === armed(decoder.decode(wanted))) return 'identical';
		} catch {
			/* not decodable as text — fall through to the byte answer */
		}
	}

	// Different content AND touched since the install: the reader wrote this,
	// so it goes to the trash rather than under the new bytes.
	return touched ? 'modified' : 'changed';
}

/**
 * A canvas reduced to what an edit would actually change.
 *
 * Switched back on, so a block the reader enabled is not read as an edit, and
 * re-serialised, so Obsidian's own rewriting of the file's indentation is not
 * either. Node positions still differ when the reader really moved something.
 */
function canvasKey(text: string): string {
	try {
		return JSON.stringify(JSON.parse(armCanvas(text)));
	} catch {
		return text;
	}
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

function sameBytes(a: ArrayBuffer, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;

	const left = new Uint8Array(a);
	return left.every((byte, index) => byte === b[index]);
}

/** One pass over the archive, entry by entry, keeping nothing. */
async function eachEntryAsync(archive: ArrayBuffer, visit: (entry: TarEntry) => Promise<void>): Promise<void> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(archive));
			controller.close();
		},
	});

	for await (const entry of readTarGz(source, {
		maxEntries: MAX_ENTRIES,
		maxTotalBytes: MAX_UNCOMPRESSED_BYTES,
		maxEntryBytes: MAX_ENTRY_BYTES,
		maxRatio: MAX_COMPRESSION_RATIO,
		maxPathLength: MAX_ENTRY_PATH,
		maxDepth: MAX_ENTRY_DEPTH,
		archiveBytes: archive.byteLength,
	})) {
		await visit(entry);
	}
}

/**
 * Checks whether an archive path is safe to write into a vault.
 *
 * Every name rule lives in tar.ts, because the worker has to enforce exactly
 * the same ones — a package it accepts and this refuses is a catalog entry
 * nobody can install. What stays here is the extension list, and it stays
 * because this is the last thing before vault.createBinary().
 */
export function safeRelativePath(name: string): string {
	assertSafeEntryName(name, MAX_ENTRY_PATH, MAX_ENTRY_DEPTH);

	const extension = extensionOf(name);
	if (!ALLOWED_EXTENSIONS.includes(extension)) {
		throw new Error(
			`Disallowed file type in archive: ${name}` + (extension ? ` (.${extension})` : ' (no extension)'),
		);
	}

	return name;
}

/**
 * Package notes whose name is already taken elsewhere in the vault.
 *
 * Obsidian resolves [[Note]] by name across the whole vault, so a package
 * shipping "Home.md" can quietly capture links in the reader's own private
 * notes and put someone else's content where they expected theirs.
 *
 * The server cannot see this — it does not know the reader's vault — which
 * makes it the one check that has to live here. A warning, not a block: an
 * overlapping name is usually a coincidence.
 */
export function findShadowedNotes(app: App, paths: string[]): string[] {
	const existing = new Set(app.vault.getMarkdownFiles().map((file) => file.basename.toLowerCase()));

	return paths
		.filter((path) => extensionOf(path) === 'md')
		.map(basenameOf)
		.filter((name) => existing.has(name.toLowerCase()));
}

function basenameOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);

	return name.slice(0, name.lastIndexOf('.'));
}

/** Creates an empty folder for the package and returns its path. */
async function createPackageFolder(app: App, baseFolder: string, packageTitle: string): Promise<string> {
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
 * false-positives, the reader can still get their files back.
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
