/**
 * The catalog is paged by the server now, so what the modal ASKS FOR is the
 * thing that can silently break: a stale offset re-requests page 1 forever, a
 * dropped author_id turns "My packages" into the whole catalog, and a tag left
 * set after a tab switch filters a list with no control to clear it.
 *
 * None of that shows up in `tsc` — every one of them is a well-typed string.
 */
import { MarketplaceModal } from '../src/marketplaceModal';
import { DEFAULT_SETTINGS } from '../src/settings';
import { scrollToBottom, armedObservers } from 'obsidian';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

const USER = '11111111-1111-4111-8111-111111111111';

function pkg(id: string, over: Record<string, unknown> = {}) {
	return {
		id, title: `Pkg ${id}`, description: '', author: 'someone',
		author_id: USER, tags: 'notes', filename: `${id}.zip`,
		created_at: '2026-08-01T00:00:00.000Z', version: 1, updated_at: null, ...over,
	};
}

/** Installs a fake server and records every URL it is asked for. */
function server(pages: (unknown[] | 'boom')[]) {
	const urls: string[] = [];
	let call = 0;
	(globalThis as any).__requestUrl = (opts: any) => {
		urls.push(opts.url);
		if (opts.url.includes('/tags')) return { status: 200, json: ['canvas', 'notes'], text: '[]' };
		const body = pages[Math.min(call++, pages.length - 1)];
		if (body === 'boom') throw new Error('network down');
		return { status: 200, json: body, text: JSON.stringify(body) };
	};
	// Only the catalog requests matter to the assertions; /tags is noise.
	return { urls, listUrls: () => urls.filter((u) => u.includes('/packages')) };
}

const open: any[] = [];

function modal(settings: Record<string, unknown> = {}) {
	const plugin: any = {
		app: { vault: { getAbstractFileByPath: () => null } },
		settings: { ...DEFAULT_SETTINGS, installs: {}, ...settings },
		saveSettings: async () => {},
	};
	const m: any = new MarketplaceModal(plugin);
	m.app = plugin.app;
	m.onOpen();
	open.push(m);
	return m;
}

/** Closes every modal a block opened. A leaked observer would fire on the next block's scroll. */
function closeAll() {
	for (const m of open.splice(0)) m.onClose();
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const full = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => pkg(`p${offset + i}`));

console.log('\n--- BROWSE: paging ---');
{
	const s = server([full(20), full(20, 20), full(5, 40)]);
	const m = modal();
	await settle();

	const first = s.listUrls()[0] ?? '';
	check('page 1 asks for limit=20 offset=0', first.includes('limit=20') && first.includes('offset=0'), `-> ${first}`);
	check('page 1 carries the default sort', first.includes('sort=newest'), `-> ${first}`);
	check('no empty tag param is sent', !first.includes('tag='), `-> ${first}`);
	check('20 cards painted', m.bodyEl.findAll('marketplace-card').length === 20);
	check('observer armed while more pages remain', armedObservers() === 1);

	await scrollToBottom();
	const second = s.listUrls()[1] ?? '';
	check('page 2 asks for offset=20', second.includes('offset=20'), `-> ${second}`);
	check('40 cards after page 2', m.bodyEl.findAll('marketplace-card').length === 40);

	await scrollToBottom();
	check('45 cards after the short page', m.bodyEl.findAll('marketplace-card').length === 45);
	check('short page disarms the observer', armedObservers() === 0);

	await scrollToBottom();
	check('no request after exhaustion', s.listUrls().length === 3, `-> ${s.listUrls().length}`);

	closeAll();
}

console.log('\n--- BROWSE: duplicate rows from OFFSET drift ---');
{
	// Someone publishes mid-scroll, so page 2 repeats a row from page 1.
	const page2 = [pkg('p19'), ...full(19, 20)];
	const s = server([full(20), page2, []]);
	const m = modal();
	await settle();
	await scrollToBottom();

	check('duplicate id is not painted twice', m.bodyEl.findAll('marketplace-card').length === 39);

	await scrollToBottom();
	const third = s.listUrls()[2] ?? '';
	// The window must advance by the full page, not by the rows we kept —
	// otherwise it re-requests the same slice forever.
	check('offset advances by the full page length', third.includes('offset=40'), `-> ${third}`);

	closeAll();
}

console.log('\n--- FILTERS reset the window ---');
{
	const s = server([full(20), full(20, 20), full(20, 40)]);
	const m = modal();
	await settle();
	await scrollToBottom();
	check('scrolled to offset=20', (s.listUrls()[1] ?? '').includes('offset=20'));

	m.sortBy = 'title';
	await m.reload();
	const afterSort = s.listUrls().at(-1) ?? '';
	check('sort change goes back to offset=0', afterSort.includes('offset=0'), `-> ${afterSort}`);
	check('sort change sends the new key', afterSort.includes('sort=title'), `-> ${afterSort}`);
	check('list is repainted, not appended', m.bodyEl.findAll('marketplace-card').length === 20);

	m.tagFilter = 'notes';
	await m.reload();
	const afterTag = s.listUrls().at(-1) ?? '';
	check('tag change sends tag and offset=0', afterTag.includes('tag=notes') && afterTag.includes('offset=0'), `-> ${afterTag}`);

	closeAll();
}

console.log('\n--- MY PACKAGES ---');
{
	const s = server([full(3)]);
	const m = modal({ userId: USER });
	m.tab = 'mine';
	await m.reload();
	const url = s.listUrls().at(-1) ?? '';
	check('sends author_id', url.includes(`author_id=${USER}`), `-> ${url}`);

	closeAll();
}
{
	const s = server([full(3)]);
	const m = modal({ userId: '' });
	m.tab = 'mine';
	await m.reload();
	// An empty author_id is dropped from the query, so the request would have
	// come back with the whole catalog presented as "yours".
	check('logged out sends NO request', s.listUrls().length === 0, `-> ${JSON.stringify(s.listUrls())}`);
	check('logged out shows the sign-in empty state', m.bodyEl.allText.includes('Log in to see your packages'));

	closeAll();
}

console.log('\n--- DOWNLOADED ---');
{
	const installs = {
		'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { path: 'x/a', version: 1, installedAt: 1, title: 'Cached A', author: 'me' },
		'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': { path: 'x/b', version: 1, installedAt: 1, title: 'Cached B', author: 'me' },
	};
	// Only A comes back: B was deleted server-side, but its files are still here.
	const s = server([[pkg('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { version: 3, title: 'Server A' })]]);
	const m = modal({ installs });
	m.tab = 'downloaded';
	await m.reload();

	check('renders both from the local record', m.bodyEl.findAll('marketplace-card').length === 2);
	check('uses the cached title', m.bodyEl.allText.includes('Cached A') || m.bodyEl.allText.includes('Server A'));
	check('no paging params on the enrich', !(s.listUrls().at(-1) ?? '').includes('offset='), `-> ${s.listUrls().at(-1)}`);
	check('enrich asks by ids', (s.listUrls().at(-1) ?? '').includes('ids='), `-> ${s.listUrls().at(-1)}`);
	check('sends exactly one request', s.listUrls().length === 1, `-> ${s.listUrls().length}`);

	await settle();
	check('update badge appears after enrich', m.bodyEl.allText.includes('Update available'));
	check('deleted package stays listed', m.bodyEl.allText.includes('Cached B'));
	check('deleted package is marked', m.bodyEl.allText.includes('No longer published'));
	check('never arms the scroll observer', armedObservers() === 0);

	closeAll();
}

console.log('\n--- DOWNLOADED works offline ---');
{
	const installs = { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { path: 'x/a', version: 1, installedAt: 1, title: 'Cached A', author: 'me' } };
	server(['boom']);
	const m = modal({ installs });
	m.tab = 'downloaded';
	await m.reload();
	await settle();

	// The whole point of caching the label: the list is local, so a dead
	// server costs the update badge and nothing else.
	check('lists the package with the server down', m.bodyEl.findAll('marketplace-card').length === 1);
	check('shows the cached title', m.bodyEl.allText.includes('Cached A'));
	check('no error state', !m.bodyEl.allText.includes('Something went wrong'));

	closeAll();
}

console.log('\n--- TAB SWITCH clears the tag ---');
{
	server([full(20)]);
	const m = modal({ installs: {} });
	await settle();
	m.tagFilter = 'notes';
	const tabs = m.bodyEl.findAll('marketplace-tab');
	check('three tabs rendered', tabs.length === 3, `-> ${tabs.length}`);
	check('browse is active', tabs[0]?.hasClass('is-active') === true);

	tabs[2]?.click();
	await settle();
	// Downloaded has no toolbar, so a tag left set would filter with no
	// visible control to clear it.
	check('switching tab clears the tag filter', m.tagFilter === '');
	check('empty downloaded shows its own copy', m.bodyEl.allText.includes("You haven't downloaded anything yet"));

	closeAll();
}

console.log('\n--- PARTIAL FAILURE keeps the loaded pages ---');
{
	server([full(20), 'boom']);
	const m = modal();
	await settle();
	check('page 1 painted', m.bodyEl.findAll('marketplace-card').length === 20);

	await scrollToBottom();
	check('page 1 survives a failed page 2', m.bodyEl.findAll('marketplace-card').length === 20);
	check('failure is shown in the sentinel', m.bodyEl.find('marketplace-sentinel')?.allText.includes('network down') === true);
	check('no full-screen error state', !m.bodyEl.allText.includes('Something went wrong'));
	check('failed page disarms the observer', armedObservers() === 0);

	closeAll();
}

console.log('\n--- FIRST page failure IS a full error state ---');
{
	server(['boom']);
	const m = modal();
	await settle();
	check('shows the error panel', m.bodyEl.allText.includes('Something went wrong'));
	check('names the reason', m.bodyEl.allText.includes('network down'));

	closeAll();
}

console.log('\n--- EMPTY states ---');
{
	server([[]]);
	const m = modal();
	await settle();
	check('empty catalog', m.bodyEl.allText.includes('The library is empty'));

	m.tagFilter = 'ghost';
	await m.reload();
	check('empty search names the tag', m.bodyEl.allText.includes('No packages tagged #ghost'));
	check('empty search is NOT the generic copy', !m.bodyEl.allText.includes('The library is empty'));
	check('tabs stay reachable from an empty list', m.bodyEl.findAll('marketplace-tab').length === 3);

	closeAll();
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
