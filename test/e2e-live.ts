/**
 * End-to-end against the LIVE local worker: publish -> catalog -> download ->
 * install -> update -> delete.
 *
 * The point is the security chain, not the HTTP. Two halves: a package of
 * inert content goes all the way through untouched, and a package with a
 * single executable fragment never gets in at all.
 */
import { readFileSync } from 'node:fs';
import { TFile, TFolder } from 'obsidian';
import { publishFolder } from '../src/api/publishApi';
import { fetchPackages, fetchPackage, downloadPackageArchive, deletePackage } from '../src/api/packagesApi';
import { inspectArchive, installPlan, planUpdate, applyUpdate } from '../src/installs';
import { API_BASE_URL } from '../src/constants';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) console.log(`  ok   ${label}`);
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

// requestUrl mapped onto node fetch, headers included — without the headers
// every auth case would pass for the wrong reason.
(globalThis as any).__requestUrl = async (opts: any) => {
	// requestUrl takes contentType as its own option, not as a header — miss it
	// and the worker rejects every multipart body with 400.
	const headers = { ...(opts.headers ?? {}), ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}) };
	const res = await fetch(opts.url, { method: opts.method ?? 'GET', headers, body: opts.body });
	const buf = await res.arrayBuffer();
	const text = new TextDecoder().decode(buf);
	return {
		status: res.status,
		arrayBuffer: buf,
		text,
		get json() { return JSON.parse(text); },
		headers: Object.fromEntries(res.headers.entries()),
	};
};

// The bundle runs from a temp file, so import.meta.url points nowhere useful;
// the runner is invoked from the plugin root, which is where data.json lives.
const stored = JSON.parse(readFileSync(`${process.cwd()}/data.json`, 'utf8'));
const settings: any = { token: stored.token, username: stored.username, userId: stored.userId, downloadFolder: 'dl', installs: {} };

// This publishes and deletes for real, as the signed-in user. Refuse anything
// that is not the local worker: a production build bakes in the real address,
// and a stray run would leave a probe package in the public catalog.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API_BASE_URL)) {
	console.log(`REFUSED: this test only runs against a local worker, not ${API_BASE_URL}`);
	process.exit(1);
}

const enc = new TextEncoder();

// Everything here is inert and has to survive the round trip unchanged. Each
// line is something a plain-text rule would plausibly get wrong.
const NOTE = [
	'# Course',
	'',
	'```dataview',
	'TABLE file.name FROM "Course"',
	'```',
	'',
	'Inline DQL: `= this.file.name`',
	'',
	'```mermaid',
	'graph TD',
	'A-->B',
	'```',
	'',
	'How you would write one:',
	'',
	'````text',
	'```dataviewjs',
	'dv.list([])',
	'```',
	'````',
	'',
	'![](https://tracker.example.com/p.png)',
	'',
].join('\n');

const CANVAS = JSON.stringify({
	nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 400, height: 200, text: '# Board\n\nPlain text.' }],
	edges: [],
});

const SOURCE: Record<string, string> = { 'Course/note.md': NOTE, 'Course/board.canvas': CANVAS, 'Course/plain.md': '# Just text\n' };

/** One executable fragment, in a package that is otherwise ordinary. */
const ARMED: Record<string, string> = { 'Armed/note.md': '# Lesson\n\n```dataviewjs\napp.vault.adapter.write("pwn.md", "owned");\n```\n' };

function sourceApp(source: Record<string, string> = SOURCE, root = 'Course') {
	const files = Object.keys(source).map((path) => Object.assign(new TFile(), { path, extension: path.split('.').pop(), name: path.split('/').pop() }));
	const folder = Object.assign(new TFolder(), { path: root, isRoot: () => false });
	const app: any = { vault: { readBinary: async (f: any) => enc.encode(source[f.path]).buffer } };
	return { app, folder, files };
}

/** Vault stand-in for the install side. */
class Vault {
	files = new Map<string, { path: string; data: Uint8Array; stat: { mtime: number } }>();
	folders = new Set<string>(['dl']);
	getAbstractFileByPath(p: string) {
		if (this.folders.has(p)) return Object.assign(new TFolder(), { path: p, children: [...this.files.values()].filter((f) => f.path.startsWith(p + '/')).map((f) => Object.assign(new TFile(), f)) });
		const f = this.files.get(p);
		return f ? Object.assign(new TFile(), f) : null;
	}
	async createFolder(p: string) { this.folders.add(p); }
	async createBinary(p: string, data: ArrayBuffer) {
		if (this.files.has(p)) throw new Error('exists: ' + p);
		this.files.set(p, { path: p, data: new Uint8Array(data), stat: { mtime: 1000 } });
	}
	async modifyBinary(f: any, data: ArrayBuffer) { this.files.set(f.path, { path: f.path, data: new Uint8Array(data), stat: { mtime: 2000 } }); }
	async readBinary(f: any) { return (this.files.get(f.path)!.data).buffer; }
	getMarkdownFiles() { return []; }
	text(p: string) { return new TextDecoder().decode(this.files.get(p)!.data); }
}

async function run() {
	console.log('\n=== 1. publish through the plugin ===');
	const { app, folder, files } = sourceApp();
	let published = '';
	try {
		await publishFolder(app, folder as any, files as any, { title: 'E2E probe', description: 'temporary', tags: ['reference'] }, settings);
	} catch (error) {
		published = String((error as Error).message);
	}
	check('inert content publishes', published === '', `-> ${published}`);

	// The half that matters most: the gate is on the server, so it holds even
	// for a sender who never ran the plugin's own pre-check.
	const armed = sourceApp(ARMED, 'Armed');
	let refusal = '';
	try {
		await publishFolder(armed.app, armed.folder as any, armed.files as any, { title: 'E2E armed', description: 'temporary', tags: ['reference'] }, settings);
	} catch (error) {
		refusal = String((error as Error).message);
	}
	check('a package with executable content is refused', refusal !== '', '-> it was accepted');
	check('the refusal names the file and the line', refusal.includes('note.md:3'), `-> ${refusal}`);

	console.log('\n=== 2. catalog ===');
	const listed = await fetchPackages(settings, { limit: 20, sort: 'newest' } as any);
	const rows = (listed as any).packages ?? listed;
	const pkg = (rows as any[]).find((p) => p.title === 'E2E probe');
	check('the package is in the catalog', pkg !== undefined);
	if (!pkg) { console.log('\nABORT'); process.exit(1); }
	check('the row carries a sha256', typeof pkg.sha256 === 'string' && pkg.sha256.length === 64);
	check('the armed package never reached the catalog', !(rows as any[]).some((p) => p.title === 'E2E armed'));

	console.log('\n=== 3. package detail ===');
	const detail = await fetchPackage(settings, pkg.id);
	check('the detail view lists the archive contents', (detail as any).structure.length === 3, `-> ${JSON.stringify((detail as any).structure)}`);

	console.log('\n=== 4. download + integrity ===');
	const archive = await downloadPackageArchive(settings, pkg.id, pkg.sha256);
	check('sha256 of the bytes matches the catalog row', archive.byteLength > 0);
	let rejected = false;
	try { await downloadPackageArchive(settings, pkg.id, 'f'.repeat(64)); } catch { rejected = true; }
	check('a wrong sha256 is refused', rejected);

	console.log('\n=== 5. inspect ===');
	const plan = await inspectArchive(archive);
	check('three files planned', plan.paths.length === 3, `-> ${JSON.stringify(plan.paths)}`);

	console.log('\n=== 6. what actually lands on disk ===');
	const vault = new Vault();
	const appI: any = { vault, fileManager: { trashFile: async (f: any) => vault.files.delete(f.path) } };
	const root = await installPlan(appI, archive, 'E2E probe', 'dl');
	const note = vault.text(`${root}/note.md`);
	const canvas = vault.text(`${root}/board.canvas`);

	// Nothing is rewritten on the way in any more, so the strongest thing to
	// assert is that the note is byte-for-byte what the author wrote.
	check('the note arrives exactly as published', note === NOTE, '-> it was rewritten');
	check('the canvas arrives exactly as published', canvas === CANVAS, '-> it was rewritten');
	check('the DQL query survives', note.includes('```dataview\n'));
	check('inline DQL survives', note.includes('`= this.file.name`'));
	check('the mermaid diagram survives', note.includes('```mermaid'));
	check('the fenced example about dataviewjs survives', note.includes('dv.list([])'));
	check('the remote image is left as it is', note.includes('![](https://tracker.example.com/p.png)'));
	check('nothing was written outside the package folder', [...vault.files.keys()].every((p) => p.startsWith(root + '/')), `-> ${JSON.stringify([...vault.files.keys()])}`);

	console.log('\n=== 7. update over the install ===');
	const update = await planUpdate(appI, archive, root, 5000);
	check('re-installing the same version is all identical', update.writes.every((w) => w.status === 'identical'), `-> ${JSON.stringify(update.writes.map((w) => w.status))}`);
	await applyUpdate(appI, archive, update);
	check('an identical update rewrites nothing', vault.text(`${root}/note.md`) === note);

	// Obsidian stamps `metadata` into any canvas it opens. Merely looking at
	// one must not count as an edit, or the next update trashes it.
	const opened = JSON.stringify({ ...JSON.parse(canvas), metadata: { version: '1.0' } });
	vault.files.set(`${root}/board.canvas`, { path: `${root}/board.canvas`, data: enc.encode(opened), stat: { mtime: 9000 } });
	const update2 = await planUpdate(appI, archive, root, 5000);
	const canvasStatus = update2.writes.find((w) => w.path === 'board.canvas')?.status;
	check('a canvas the reader merely opened is not read as an edit', canvasStatus === 'identical', `-> ${canvasStatus}`);

	console.log('\n=== 8. cleanup ===');
	await deletePackage(settings, pkg.id);
	const after = await fetchPackages(settings, { limit: 50, sort: 'newest' } as any);
	const rows2 = (after as any).packages ?? after;
	check('the probe package is gone', !(rows2 as any[]).some((p) => p.id === pkg.id));

	console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
	process.exit(failures ? 1 : 0);
}

void run();
