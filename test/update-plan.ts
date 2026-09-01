/**
 * Exercises the only code in the project that overwrites and deletes the
 * user's own content: planUpdate() / applyUpdate() in installs.ts.
 *
 * Every branch here is a data-loss branch, and none of them is visible to
 * `tsc`: a byte comparison that stops working turns every sync-touched file
 * into a "local edit" and trashes the whole package, while an mtime check
 * that stops working overwrites real edits with no trace.
 */
import { TFile, TFolder } from 'obsidian';
import { inspectArchive, planUpdate, applyUpdate } from '../src/installs';
import { writeTarGz } from '../src/tar';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

const encoder = new TextEncoder();
const bytes = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;

const ROOT = 'downloads/Package';
const INSTALLED_AT = 1_000;

/** Vault stand-in: a path map plus a log of every write, so order can be asserted. */
class FakeVault {
	files = new Map<string, any>();
	folders = new Map<string, any>();
	log: string[] = [];

	constructor(root: string) {
		let current = '';
		for (const segment of root.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			this.addFolder(current);
		}
	}

	addFolder(path: string) {
		if (this.folders.has(path)) return this.folders.get(path);

		const folder: any = new TFolder();
		folder.path = path;
		folder.children = [];
		this.folders.set(path, folder);

		const parent = this.folders.get(path.slice(0, path.lastIndexOf('/')));
		if (parent) parent.children.push(folder);

		return folder;
	}

	/** Seeds a file that is already in the vault — not a write, so it isn't logged. */
	addFile(path: string, content: string, mtime: number) {
		const file: any = new TFile();
		file.path = path;
		file.data = bytes(content);
		file.stat = { mtime, ctime: mtime, size: content.length };
		this.files.set(path, file);
		this.folders.get(path.slice(0, path.lastIndexOf('/'))).children.push(file);
		return file;
	}

	getAbstractFileByPath(path: string) {
		return this.files.get(path) ?? this.folders.get(path) ?? null;
	}

	async readBinary(file: any): Promise<ArrayBuffer> {
		return file.data;
	}

	async createBinary(path: string, data: ArrayBuffer) {
		if (this.files.has(path)) throw new Error(`createBinary on an existing file: ${path}`);
		this.log.push(`create ${path}`);
		this.addFile(path, '', Date.now()).data = data;
	}

	async modifyBinary(file: any, data: ArrayBuffer) {
		this.log.push(`modify ${file.path}`);
		file.data = data;
	}

	async createFolder(path: string) {
		this.log.push(`folder ${path}`);
		this.addFolder(path);
	}
}

async function run() {
	// The archive the server would hand us.
	const archive = (
		await writeTarGz([
			{ name: 'Same.md', data: encoder.encode('unchanged text') },
			{ name: 'Old.md', data: encoder.encode('v2 text') },
			{ name: 'Edited.md', data: encoder.encode('v2 text') },
			{ name: 'New.md', data: encoder.encode('brand new') },
			{ name: 'Note.md', data: encoder.encode('v2 text') },
		])
	).buffer as ArrayBuffer;

	const vault = new FakeVault(ROOT);
	// Identical content but a fresh mtime — exactly what Obsidian Sync,
	// Dropbox or a git checkout leaves behind.
	vault.addFile(`${ROOT}/Same.md`, 'unchanged text', INSTALLED_AT + 5_000);
	vault.addFile(`${ROOT}/Old.md`, 'v1 text', INSTALLED_AT - 100);
	vault.addFile(`${ROOT}/Edited.md`, 'v1 text plus my own notes', INSTALLED_AT + 5_000);
	// The vault spells it lowercase; the archive spells it uppercase. On
	// macOS and Windows these are the same file.
	vault.addFile(`${ROOT}/note.md`, 'v1 text', INSTALLED_AT - 100);
	// The user's own note, not part of the package.
	vault.addFile(`${ROOT}/Mine.md`, 'my notes', INSTALLED_AT + 5_000);

	const trashed: string[] = [];
	const app: any = {
		vault,
		fileManager: {
			trashFile: async (file: any) => {
				vault.log.push(`trash ${file.path}`);
				trashed.push(file.path);
				vault.files.delete(file.path);
			},
		},
	};

	await inspectArchive(archive);
	const update = await planUpdate(app, archive, ROOT, INSTALLED_AT);

	const status = (path: string) => update.writes.find((write) => write.path === path)?.status;

	console.log('\n--- classification ---');
	check('identical content is never a local edit, whatever the mtime says', status('Same.md') === 'identical', `-> ${status('Same.md')}`);
	check('changed upstream, untouched locally -> changed', status('Old.md') === 'changed', `-> ${status('Old.md')}`);
	check('changed upstream, edited locally -> modified', status('Edited.md') === 'modified', `-> ${status('Edited.md')}`);
	check('absent from the folder -> new', status('New.md') === 'new', `-> ${status('New.md')}`);
	check('case-insensitive match finds the existing file', status('Note.md') === 'changed', `-> ${status('Note.md')}`);

	await applyUpdate(app, archive, update);

	console.log('\n--- writes ---');
	console.log('  log:', JSON.stringify(vault.log));
	check('an identical file is not rewritten', !vault.log.some((entry) => entry.includes('Same.md')));
	check('an upstream change is written in place', vault.log.includes(`modify ${ROOT}/Old.md`));
	check('a new file is created', vault.log.includes(`create ${ROOT}/New.md`));
	// Recoverable, not overwritten: this is the whole reason for the mtime check.
	check('a local edit goes to the trash first', vault.log.indexOf(`trash ${ROOT}/Edited.md`) >= 0
		&& vault.log.indexOf(`trash ${ROOT}/Edited.md`) < vault.log.indexOf(`create ${ROOT}/Edited.md`));
	check('the case variant is modified, not created', vault.log.includes(`modify ${ROOT}/note.md`)
		&& !vault.log.some((entry) => entry === `create ${ROOT}/Note.md`));
	check('a note the user added is left alone', vault.files.has(`${ROOT}/Mine.md`) && !trashed.includes(`${ROOT}/Mine.md`));

	console.log('\n--- repeat is a no-op ---');
	// A failed update must be safe to retry, and that only holds if a second
	// run over an already-updated folder writes nothing at all.
	const second = await planUpdate(app, archive, ROOT, Date.now());
	vault.log.length = 0;
	await applyUpdate(app, archive, second);
	check('re-running the same update writes nothing', vault.log.length === 0, `-> ${JSON.stringify(vault.log)}`);
}

await run();

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
