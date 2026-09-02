/**
 * End-to-end against the LIVE local worker: publish -> catalog -> manifest ->
 * download -> install -> update -> delete.
 *
 * The point is the security chain, not the HTTP: what the SERVER says a package
 * does, and what actually lands on disk after the plugin has written it.
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

// One note carrying every shape that matters, plus a canvas.
const NOTE = [
	'# Course',
	'',
	'```dataviewjs',
	'app.vault.adapter.write("pwn.md", "owned");',
	'```',
	'',
	'Inline JS: `$= app.vault.adapter.write("pwn2.md","x")`',
	'',
	'Inline DQL: `= this.file.name`',
	'',
	'Dynamic: <%+ tp.user.evil() %>',
	'',
	'Plain command: <% tp.file.title %>',
	'',
	'<iframe src="https://embed.example.com/x"></iframe>',
	'',
	'![](https://tracker.example.com/p.png)',
	'',
].join('\n');

const CANVAS = JSON.stringify({
	nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 400, height: 200, text: '```dataviewjs\ndv.pages()\n```' }],
	edges: [],
});

const SOURCE: Record<string, string> = { 'Course/note.md': NOTE, 'Course/board.canvas': CANVAS, 'Course/plain.md': '# Just text\n' };

function sourceApp() {
	const files = Object.keys(SOURCE).map((path) => Object.assign(new TFile(), { path, extension: path.split('.').pop(), name: path.split('/').pop() }));
	const folder = Object.assign(new TFolder(), { path: 'Course', isRoot: () => false });
	const app: any = { vault: { readBinary: async (f: any) => enc.encode(SOURCE[f.path]).buffer } };
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
	const capabilities = await publishFolder(app, folder as any, files as any, { title: 'E2E probe', description: 'temporary', tags: ['test'] }, settings);
	check('the server answered with capabilities', Array.isArray(capabilities) && capabilities.length > 0, `-> ${JSON.stringify(capabilities)}`);
	check('it reports running code', capabilities.includes('js'));
	check('it reports writing to the vault', capabilities.includes('vault-write'));

	console.log('\n=== 2. catalog ===');
	const listed = await fetchPackages(settings, { limit: 20, sort: 'newest' } as any);
	const rows = (listed as any).packages ?? listed;
	const pkg = (rows as any[]).find((p) => p.title === 'E2E probe');
	check('the package is in the catalog', pkg !== undefined);
	if (!pkg) { console.log('\nABORT'); process.exit(1); }
	check('the row carries a sha256', typeof pkg.sha256 === 'string' && pkg.sha256.length === 64);
	check('the row carries policy_version 2', pkg.policyVersion === 2, `-> ${pkg.policyVersion}`);

	console.log('\n=== 3. the manifest the SERVER computed ===');
	const detail = await fetchPackage(settings, pkg.id);
	const findings = (detail as any).manifest?.findings ?? [];
	const has = (i: string, t: string) => findings.some((f: any) => f.interpreter === i && f.trigger === t);
	check('fenced dataviewjs -> Dataview / render', has('Dataview', 'render'));
	check('inline `$=` is described', findings.filter((f: any) => f.interpreter === 'Dataview' && f.trigger === 'render').length >= 2, `-> ${findings.filter((f:any)=>f.interpreter==='Dataview').length} Dataview findings`);
	check('dynamic Templater -> render, not command', findings.some((f: any) => f.interpreter === 'Templater' && f.trigger === 'render'));
	check('plain Templater -> command', findings.some((f: any) => f.interpreter === 'Templater' && f.trigger === 'command'));
	check('the canvas node is described', findings.some((f: any) => f.path === 'board.canvas'));
	check('the iframe is described', findings.some((f: any) => f.capabilities.includes('remote-embed')));

	console.log('\n=== 4. download + integrity ===');
	const archive = await downloadPackageArchive(settings, pkg.id, pkg.sha256);
	check('sha256 of the bytes matches the catalog row', archive.byteLength > 0);
	let rejected = false;
	try { await downloadPackageArchive(settings, pkg.id, 'f'.repeat(64)); } catch { rejected = true; }
	check('a wrong sha256 is refused', rejected);

	console.log('\n=== 5. inspect: is the promise true for THIS package? ===');
	const plan = await inspectArchive(archive, findings);
	check('three files planned', plan.paths.length === 3, `-> ${JSON.stringify(plan.paths)}`);
	check('nothing was left armed', plan.stillArmed.length === 0, `-> ${JSON.stringify(plan.stillArmed)}`);

	console.log('\n=== 6. what actually lands on disk ===');
	const vault = new Vault();
	const appI: any = { vault, fileManager: { trashFile: async (f: any) => vault.files.delete(f.path) } };
	const root = await installPlan(appI, archive, 'E2E probe', 'dl');
	const note = vault.text(`${root}/note.md`);
	const canvas = vault.text(`${root}/board.canvas`);

	check('fenced dataviewjs is off', note.includes('```dataviewjs-off'));
	check('inline $= is off', note.includes('`off:$= app.vault'));
	check('dynamic Templater is off', note.includes('<%off:+'));
	check('iframe source is parked', note.includes('data-off-src="https://embed.example.com/x"'));
	check('the code is still there, unchanged', note.includes('app.vault.adapter.write("pwn.md", "owned")'));
	check('plain Templater command survives untouched', note.includes('<% tp.file.title %>'));
	check('inline DQL survives untouched', note.includes('`= this.file.name`'));
	check('the remote image is left as it is', note.includes('![](https://tracker.example.com/p.png)'));
	check('the canvas node is off', canvas.includes('dataviewjs-off'));
	check('nothing was written outside the package folder', [...vault.files.keys()].every((p) => p.startsWith(root + '/')), `-> ${JSON.stringify([...vault.files.keys()])}`);

	console.log('\n=== 7. update over the install ===');
	const update = await planUpdate(appI, archive, root, 5000);
	check('re-installing the same version is all identical', update.writes.every((w) => w.status === 'identical'), `-> ${JSON.stringify(update.writes.map((w) => w.status))}`);
	await applyUpdate(appI, archive, update);
	check('an identical update rewrites nothing', vault.text(`${root}/note.md`) === note);

	// The reader enables a block; the next update must not read that as their edit.
	const armedNote = note.replace('```dataviewjs-off', '```dataviewjs');
	vault.files.set(`${root}/note.md`, { path: `${root}/note.md`, data: enc.encode(armedNote), stat: { mtime: 9000 } });
	const update2 = await planUpdate(appI, archive, root, 5000);
	const noteStatus = update2.writes.find((w) => w.path === 'note.md')?.status;
	check('a block the reader switched on is not read as an edit', noteStatus === 'identical', `-> ${noteStatus}`);

	console.log('\n=== 8. cleanup ===');
	await deletePackage(settings, pkg.id);
	const after = await fetchPackages(settings, { limit: 50, sort: 'newest' } as any);
	const rows2 = (after as any).packages ?? after;
	check('the probe package is gone', !(rows2 as any[]).some((p) => p.id === pkg.id));

	console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
	process.exit(failures ? 1 : 0);
}

void run();
